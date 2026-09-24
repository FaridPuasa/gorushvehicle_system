const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();
const cors = require('cors');

// Postgres-only data access - fully cut over from Mongo 2026-09-18. See
// postgresVehicleSystem.js's header for the parity check this was based on.
const db = require('./postgresVehicleSystem');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// API Routes

app.get('/api/vehicles', async (req, res) => {
    try {
        const vehicles = await db.findAllVehicles();
        res.json(vehicles);
    } catch (error) {
        console.error('Error fetching vehicles:', error);
        res.status(500).json({ message: 'Failed to fetch vehicles' });
    }
});

// Bulk fetch for the dashboard, which used to fire one insurance + one tax
// request per vehicle. Two queries total instead of 2N.
app.get('/api/dashboard/expiry-data', async (req, res) => {
    try {
        const [insurances, taxes] = await Promise.all([
            db.findAllInsurances(),
            db.findAllRoadTaxes(),
        ]);
        res.json({ insurances, taxes });
    } catch (error) {
        console.error('Error fetching dashboard expiry data:', error);
        res.status(500).json({ message: 'Failed to fetch expiry data' });
    }
});

app.get('/api/vehicles/:id', async (req, res) => {
    try {
        const vehicle = await db.findVehicleById(req.params.id);
        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.json(vehicle);
    } catch (error) {
        console.error('Error fetching vehicle:', error);
        res.status(500).json({ message: 'Failed to fetch vehicle' });
    }
});

app.post('/api/vehicles', async (req, res) => {
    try {
        const savedVehicle = await db.createVehicle(req.body);
        res.status(201).json(savedVehicle);
    } catch (error) {
        console.error('Error adding vehicle:', error);
        res.status(500).json({ message: 'Failed to add vehicle' });
    }
});

// PUT (update) a vehicle
app.put('/api/vehicles/:id', async (req, res) => {
    try {
        // Simple validation
        if (!req.body.engine) {
            return res.status(400).json({ message: 'Engine information is required' });
        }

        const updatedVehicle = await db.updateVehicle(req.params.id, req.body);

        if (!updatedVehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        res.json(updatedVehicle);
    } catch (error) {
        console.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'Failed to update vehicle' });
    }
});

// Delete vehicle - Postgres cascade delete (onDelete: Cascade on every
// child table's vehicleId FK) handles all associated records automatically.
app.delete('/api/vehicles/:id', async (req, res) => {
    try {
        const deletedVehicle = await db.deleteVehicle(req.params.id);

        if (!deletedVehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        res.json({ message: 'Vehicle and all associated records deleted successfully' });
    } catch (error) {
        console.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'Failed to delete vehicle' });
    }
});

// GET maintenance logs for a vehicle
app.get('/api/vehicles/:id/logs', async (req, res) => {
    try {
        const logs = await db.findMaintenanceLogsForVehicle(req.params.id);
        res.json(logs);
    } catch (error) {
        console.error('Error fetching maintenance logs:', error);
        res.status(500).json({ message: 'Failed to fetch maintenance logs' });
    }
});

// GET a specific log entry
app.get('/api/logs/:id', async (req, res) => {
    try {
        const log = await db.findMaintenanceLogById(req.params.id);

        if (!log) {
            return res.status(404).json({ message: 'Maintenance log not found' });
        }

        res.json(log);
    } catch (error) {
        console.error('Error fetching maintenance log:', error);
        res.status(500).json({ message: 'Failed to fetch maintenance log' });
    }
});

app.post('/api/logs', async (req, res) => {
    try {
        req.body.nextServiceMileage = req.body.odometer + 7000;

        const result = await db.createMaintenanceLog(req.body);
        if (result.error === 'vehicle_not_found') {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        // Update vehicle with latest service information
        await db.updateVehicleServiceInfo(req.body.vehicleId, {
            lastService: req.body.date,
            nextService: req.body.nextServiceDue,
            currentMileage: req.body.odometer,
        });

        res.status(201).json(result.log);
    } catch (error) {
        console.error('Error adding maintenance log:', error);
        res.status(500).json({ message: 'Failed to add maintenance log' });
    }
});

// PUT (update) a maintenance log
app.put('/api/logs/:id', async (req, res) => {
    try {
        // Calculate next service mileage
        req.body.nextServiceMileage = req.body.odometer + 7000;

        const updatedLog = await db.updateMaintenanceLog(req.params.id, req.body);

        if (!updatedLog) {
            return res.status(404).json({ message: 'Maintenance log not found' });
        }

        // Update vehicle with latest service information if this is the most recent log
        const mostRecentLog = await db.findMostRecentMaintenanceLog(updatedLog.vehicleId);

        if (mostRecentLog && mostRecentLog._id === updatedLog._id) {
            await db.updateVehicleServiceInfo(updatedLog.vehicleId, {
                lastService: updatedLog.date,
                nextService: updatedLog.nextServiceDue,
                currentMileage: updatedLog.odometer,
            });
        }

        res.json(updatedLog);
    } catch (error) {
        console.error('Error updating maintenance log:', error);
        res.status(500).json({ message: 'Failed to update maintenance log' });
    }
});

// DELETE a maintenance log
app.delete('/api/logs/:id', async (req, res) => {
    try {
        const log = await db.findMaintenanceLogById(req.params.id);

        if (!log) {
            return res.status(404).json({ message: 'Maintenance log not found' });
        }

        await db.deleteMaintenanceLog(req.params.id);

        // Update vehicle's last service information if needed
        const mostRecentLog = await db.findMostRecentMaintenanceLog(log.vehicleId);

        if (mostRecentLog) {
            await db.updateVehicleServiceInfo(log.vehicleId, {
                lastService: mostRecentLog.date,
                nextService: mostRecentLog.nextServiceDue,
            });
        } else {
            // No logs left, clear the service dates
            await db.updateVehicleServiceInfo(log.vehicleId, {
                lastService: null,
                nextService: null,
            });
        }

        res.json({ message: 'Maintenance log deleted successfully' });
    } catch (error) {
        console.error('Error deleting maintenance log:', error);
        res.status(500).json({ message: 'Failed to delete maintenance log' });
    }
});

// GET road tax logs for a vehicle
app.get('/api/vehicles/:id/taxes', async (req, res) => {
    try {
        const taxes = await db.findRoadTaxesForVehicle(req.params.id);
        res.json(taxes);
    } catch (error) {
        console.error('Error fetching road tax logs:', error);
        res.status(500).json({ message: 'Failed to fetch road tax logs' });
    }
});

// GET a specific road tax entry
app.get('/api/taxes/:id', async (req, res) => {
    try {
        const tax = await db.findRoadTaxById(req.params.id);

        if (!tax) {
            return res.status(404).json({ message: 'Road tax entry not found' });
        }

        res.json(tax);
    } catch (error) {
        console.error('Error fetching road tax entry:', error);
        res.status(500).json({ message: 'Failed to fetch road tax entry' });
    }
});

app.post('/api/taxes', async (req, res) => {
    try {
        const result = await db.createRoadTax(req.body);
        if (result.error === 'vehicle_not_found') {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.status(201).json(result.entry);
    } catch (error) {
        console.error('Error adding road tax entry:', error);
        res.status(500).json({ message: 'Failed to add road tax entry' });
    }
});

// PUT (update) a road tax entry
app.put('/api/taxes/:id', async (req, res) => {
    try {
        const updatedTax = await db.updateRoadTax(req.params.id, req.body);

        if (!updatedTax) {
            return res.status(404).json({ message: 'Road tax entry not found' });
        }

        res.json(updatedTax);
    } catch (error) {
        console.error('Error updating road tax entry:', error);
        res.status(500).json({ message: 'Failed to update road tax entry' });
    }
});

// DELETE a road tax entry
app.delete('/api/taxes/:id', async (req, res) => {
    try {
        const deletedTax = await db.deleteRoadTax(req.params.id);

        if (!deletedTax) {
            return res.status(404).json({ message: 'Road tax entry not found' });
        }

        res.json({ message: 'Road tax entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting road tax entry:', error);
        res.status(500).json({ message: 'Failed to delete road tax entry' });
    }
});

// GET fuel logs for a vehicle
app.get('/api/vehicles/:id/fuel', async (req, res) => {
    try {
        const fuelLogs = await db.findFuelLogsForVehicle(req.params.id);
        res.json(fuelLogs);
    } catch (error) {
        console.error('Error fetching fuel logs:', error);
        res.status(500).json({ message: 'Failed to fetch fuel logs' });
    }
});

// GET a specific fuel log entry
app.get('/api/fuel/:id', async (req, res) => {
    try {
        const fuelLog = await db.findFuelLogById(req.params.id);

        if (!fuelLog) {
            return res.status(404).json({ message: 'Fuel log entry not found' });
        }

        res.json(fuelLog);
    } catch (error) {
        console.error('Error fetching fuel log entry:', error);
        res.status(500).json({ message: 'Failed to fetch fuel log entry' });
    }
});

// POST a new fuel log entry
app.post('/api/fuel', async (req, res) => {
    try {
        const result = await db.createFuelLog(req.body);
        if (result.error === 'vehicle_not_found') {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.status(201).json(result.entry);
    } catch (error) {
        console.error('Error adding fuel log entry:', error);
        res.status(500).json({ message: 'Failed to add fuel log entry' });
    }
});

// PUT (update) a fuel log entry
app.put('/api/fuel/:id', async (req, res) => {
    try {
        const updatedFuelLog = await db.updateFuelLog(req.params.id, req.body);

        if (!updatedFuelLog) {
            return res.status(404).json({ message: 'Fuel log entry not found' });
        }

        res.json(updatedFuelLog);
    } catch (error) {
        console.error('Error updating fuel log entry:', error);
        res.status(500).json({ message: 'Failed to update fuel log entry' });
    }
});

// DELETE a fuel log entry
app.delete('/api/fuel/:id', async (req, res) => {
    try {
        const deletedFuelLog = await db.deleteFuelLog(req.params.id);

        if (!deletedFuelLog) {
            return res.status(404).json({ message: 'Fuel log entry not found' });
        }

        res.json({ message: 'Fuel log entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting fuel log entry:', error);
        res.status(500).json({ message: 'Failed to delete fuel log entry' });
    }
});

// GET insurance logs for a vehicle
app.get('/api/vehicles/:id/insurance', async (req, res) => {
    try {
        const insuranceLogs = await db.findInsurancesForVehicle(req.params.id);
        res.json(insuranceLogs);
    } catch (error) {
        console.error('Error fetching insurance logs:', error);
        res.status(500).json({ message: 'Failed to fetch insurance logs' });
    }
});

// GET a specific insurance entry
app.get('/api/insurance/:id', async (req, res) => {
    try {
        const insurance = await db.findInsuranceById(req.params.id);

        if (!insurance) {
            return res.status(404).json({ message: 'Insurance entry not found' });
        }

        res.json(insurance);
    } catch (error) {
        console.error('Error fetching insurance entry:', error);
        res.status(500).json({ message: 'Failed to fetch insurance entry' });
    }
});

app.post('/api/insurance', async (req, res) => {
    try {
        const result = await db.createInsurance(req.body);
        if (result.error === 'vehicle_not_found') {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.status(201).json(result.entry);
    } catch (error) {
        console.error('Error adding insurance entry:', error);
        res.status(500).json({ message: 'Failed to add insurance entry' });
    }
});

// PUT (update) an insurance entry
app.put('/api/insurance/:id', async (req, res) => {
    try {
        const updatedInsurance = await db.updateInsurance(req.params.id, req.body);

        if (!updatedInsurance) {
            return res.status(404).json({ message: 'Insurance entry not found' });
        }

        res.json(updatedInsurance);
    } catch (error) {
        console.error('Error updating insurance entry:', error);
        res.status(500).json({ message: 'Failed to update insurance entry' });
    }
});

// DELETE an insurance entry
app.delete('/api/insurance/:id', async (req, res) => {
    try {
        const deletedInsurance = await db.deleteInsurance(req.params.id);

        if (!deletedInsurance) {
            return res.status(404).json({ message: 'Insurance entry not found' });
        }

        res.json({ message: 'Insurance entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting insurance entry:', error);
        res.status(500).json({ message: 'Failed to delete insurance entry' });
    }
});

// GET location logs for a vehicle
app.get('/api/vehicles/:id/locations', async (req, res) => {
    try {
        const locations = await db.findLocationsForVehicle(req.params.id);
        res.json(locations);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Failed to fetch location logs' });
    }
});

// GET a specific location entry
app.get('/api/locations/:id', async (req, res) => {
    try {
        const location = await db.findLocationById(req.params.id);

        if (!location) {
            return res.status(404).json({ message: 'Location entry not found' });
        }

        res.json(location);
    } catch (error) {
        console.error('Error fetching location entry:', error);
        res.status(500).json({ message: 'Failed to fetch location entry' });
    }
});

// POST a new location entry
app.post('/api/locations', async (req, res) => {
    try {
        const result = await db.createLocation(req.body);
        if (result.error === 'vehicle_not_found') {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.status(201).json(result.entry);
    } catch (error) {
        console.error('Error adding location entry:', error);
        res.status(500).json({ message: 'Failed to add location entry' });
    }
});

// PUT (update) a location entry
app.put('/api/locations/:id', async (req, res) => {
    try {
        const updatedLocation = await db.updateLocation(req.params.id, req.body);

        if (!updatedLocation) {
            return res.status(404).json({ message: 'Location entry not found' });
        }

        res.json(updatedLocation);
    } catch (error) {
        console.error('Error updating location entry:', error);
        res.status(500).json({ message: 'Failed to update location entry' });
    }
});

// DELETE a location entry
app.delete('/api/locations/:id', async (req, res) => {
    try {
        const deletedLocation = await db.deleteLocation(req.params.id);

        if (!deletedLocation) {
            return res.status(404).json({ message: 'Location entry not found' });
        }

        res.json({ message: 'Location entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting location entry:', error);
        res.status(500).json({ message: 'Failed to delete location entry' });
    }
});

app.get('/api/mileage/latest', async (req, res) => {
    try {
        const { vehicleId } = req.query;
        const latestMileage = await db.findLatestMileage(vehicleId);
        res.json(latestMileage);
    } catch (error) {
        console.error('Error fetching latest mileage:', error);
        res.status(500).json({ message: 'Failed to fetch latest mileage' });
    }
});

app.get('/api/vehicles/:id/mileage/history', async (req, res) => {
    try {
        const { id: vehicleId } = req.params;
        const { startDate, endDate } = req.query;
        const mileageLogs = await db.findMileageHistory(vehicleId, startDate, endDate);
        res.json(mileageLogs);
    } catch (error) {
        console.error('Error fetching mileage history:', error);
        res.status(500).json({ message: 'Failed to fetch mileage history' });
    }
});

// POST a new mileage log entry
app.post('/api/mileage', async (req, res) => {
    try {
        const result = await db.createMileageLog(req.body);
        if (result.error === 'vehicle_not_found') {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.status(201).json(result.entry);
    } catch (error) {
        console.error('Error adding mileage log:', error);
        res.status(500).json({ message: 'Failed to add mileage log' });
    }
});

// GET all mileage logs for a vehicle
app.get('/api/vehicles/:id/mileage', async (req, res) => {
    try {
        const mileageLogs = await db.findAllMileageForVehicle(req.params.id);
        res.json(mileageLogs);
    } catch (error) {
        console.error('Error fetching mileage logs:', error);
        res.status(500).json({ message: 'Failed to fetch mileage logs' });
    }
});

app.get('/api/mileage/by-date', async (req, res) => {
    try {
        const { vehicleId, date } = req.query;

        if (!vehicleId || !date) {
            return res.status(400).json({ message: 'Vehicle ID and date are required' });
        }

        const mileageLog = await db.findMileageByDate(vehicleId, date);
        res.json(mileageLog);
    } catch (error) {
        console.error('Error fetching mileage by date:', error);
        res.status(500).json({ message: 'Failed to fetch mileage data' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the app at: http://localhost:${PORT}`);
});
