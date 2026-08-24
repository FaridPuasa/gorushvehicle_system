const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();
const cors = require('cors');

// Postgres/Supabase dual-write (migration to the shared Supabase project
// grfmxstatusupdate also migrates into, `vehicle` schema). Off by default -
// see dualWrite.js. Postgres write failures never fail the Mongo request;
// they're caught and logged only.
const prisma = require('./prismaClient');
const { isDualWriteEnabled } = require('./dualWrite');

async function dualWriteUpsert(collectionName, prismaModel, mongoId, data) {
    if (!isDualWriteEnabled(collectionName)) return;
    try {
        await prismaModel.upsert({
            where: { mongoId },
            create: { mongoId, ...data },
            update: data,
        });
    } catch (err) {
        console.error(`[Postgres dual-write] ${collectionName} upsert failed for mongoId=${mongoId}:`, err.message);
    }
}

async function dualWriteDelete(collectionName, prismaModel, mongoId) {
    if (!isDualWriteEnabled(collectionName)) return;
    try {
        await prismaModel.deleteMany({ where: { mongoId } });
    } catch (err) {
        console.error(`[Postgres dual-write] ${collectionName} delete failed for mongoId=${mongoId}:`, err.message);
    }
}

// Every child log's vehicleId is a Mongo ObjectId - resolves it to the
// matching Postgres Vehicle row's bigint id via the mongoId cross-reference.
// Returns null if that vehicle hasn't been dual-written/backfilled into
// Postgres yet, in which case the caller must skip its own dual-write
// (the FK constraint would fail otherwise).
async function getPgVehicleId(mongoVehicleId) {
    if (!isDualWriteEnabled('vehicles') && !isDualWriteEnabled('maintenanceLogs') && !isDualWriteEnabled('roadTaxes') &&
        !isDualWriteEnabled('fuelLogs') && !isDualWriteEnabled('insurances') && !isDualWriteEnabled('locations') &&
        !isDualWriteEnabled('mileageLogs')) return null;
    if (!mongoVehicleId) return null;
    try {
        const v = await prisma.vehicle.findUnique({ where: { mongoId: mongoVehicleId.toString() }, select: { id: true } });
        return v ? v.id : null;
    } catch (err) {
        console.error('[Postgres dual-write] getPgVehicleId lookup failed:', err.message);
        return null;
    }
}


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected successfully'))
.catch(err => console.error('MongoDB connection error:', err));

// Define Mongoose Schemas
const vehicleSchema = new mongoose.Schema({
    year: Number,
    make: String,
    model: String,
    plate: { type: String, required: true },
    engine: String,
    chasis: String,
    status: { type: String, default: 'active' },
    fuelType: String,
    acquisitionDate: Date,
    currentMileage: { type: Number, default: 0 },
    lastService: Date,
    nextService: Date,
    createdAt: { type: Date, default: Date.now }
});

//maintenance log schema
const maintenanceLogSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle',
        required: true
    },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    odometer: { type: Number, required: true },
    nextServiceMileage: { type: Number, required: false },
    serviceProvider: String,
    cost: Number,
    nextServiceDue: Date,
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

//road tax schema
const roadTaxSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle',
        required: true
    },
    taxId: { type: String, required: true },
    renewalDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    cost: { type: Number, required: true },
    agent: String,
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

// fuel log schema
const fuelLogSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle',
        required: true
    },
    receiptNumber: { type: String, required: true },
    date: { type: Date, required: true },
    driver: { type: String, required: true },
    cost: { type: Number, required: true },
    amount: { type: String, required: true },
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

// insurance schema
const insuranceSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle',
        required: true
    },
    insuranceId: { type: String, required: true },
    provider: { type: String, required: true },
    renewalDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    cost: { type: Number, required: true },
    agent: String,
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

// location schema
const locationSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle',
        required: true
    },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    location: { type: String, required: true },
    agent: String,
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

// daily mileage schema
const mileageLogSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle',
        required: true
    },
    date: { type: Date, required: true, default: Date.now },
    mileage: { type: Number, required: true },
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

// Create models
const Vehicle = mongoose.model('Vehicle', vehicleSchema);
const MaintenanceLog = mongoose.model('MaintenanceLog', maintenanceLogSchema);
const RoadTax = mongoose.model('RoadTax', roadTaxSchema);
const FuelLog = mongoose.model('FuelLog', fuelLogSchema);
const Insurance = mongoose.model('Insurance', insuranceSchema);
const Location = mongoose.model('Location', locationSchema);
const MileageLog = mongoose.model('MileageLog', mileageLogSchema);

// API Routes

app.get('/api/vehicles', async (req, res) => {
    try {
        const vehicles = await Vehicle.find().sort({ createdAt: -1 });
        res.json(vehicles);
    } catch (error) {
        console.error('Error fetching vehicles:', error);
        res.status(500).json({ message: 'Failed to fetch vehicles' });
    }
});

app.get('/api/vehicles/:id', async (req, res) => {
    try {
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.json(vehicle);
    } catch (error) {
        console.error('Error fetching vehicle:', error);
        res.status(500).json({ message: 'Failed to fetch vehicle' });
    }
});


// POST a new vehicle
// Builds the Postgres-shaped payload from a Vehicle Mongo document.
function vehicleToPgData(doc) {
    return {
        year: doc.year ?? null,
        make: doc.make ?? null,
        model: doc.model ?? null,
        plate: doc.plate,
        engine: doc.engine ?? null,
        chasis: doc.chasis ?? null,
        status: doc.status || 'active',
        fuelType: doc.fuelType ?? null,
        acquisitionDate: doc.acquisitionDate ?? null,
        currentMileage: doc.currentMileage ?? 0,
        lastService: doc.lastService ?? null,
        nextService: doc.nextService ?? null,
    };
}

app.post('/api/vehicles', async (req, res) => {
    try {
        const newVehicle = new Vehicle(req.body);
        const savedVehicle = await newVehicle.save();

        dualWriteUpsert('vehicles', prisma.vehicle, savedVehicle._id.toString(), vehicleToPgData(savedVehicle));

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

        const updatedVehicle = await Vehicle.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedVehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        await dualWriteUpsert('vehicles', prisma.vehicle, updatedVehicle._id.toString(), vehicleToPgData(updatedVehicle));

        res.json(updatedVehicle);
    } catch (error) {
        console.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'Failed to update vehicle' });
    }
});

// Delete vehicle
app.delete('/api/vehicles/:id', async (req, res) => {
    try {
        const deletedVehicle = await Vehicle.findByIdAndDelete(req.params.id);

        if (!deletedVehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        // Delete all associated records
        await Promise.all([
            MaintenanceLog.deleteMany({ vehicleId: req.params.id }),
            RoadTax.deleteMany({ vehicleId: req.params.id }),
            FuelLog.deleteMany({ vehicleId: req.params.id }),
            Insurance.deleteMany({ vehicleId: req.params.id }),
            Location.deleteMany({ vehicleId: req.params.id })
        ]);

        // Postgres side: deleting the Vehicle row cascades to every child
        // table (onDelete: Cascade in schema.prisma) - no need to delete
        // each child model separately here.
        await dualWriteDelete('vehicles', prisma.vehicle, req.params.id);

        res.json({ message: 'Vehicle and all associated records deleted successfully' });
    } catch (error) {
        console.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'Failed to delete vehicle' });
    }
});

// GET maintenance logs for a vehicle
app.get('/api/vehicles/:id/logs', async (req, res) => {
    try {
        const logs = await MaintenanceLog.find({ 
            vehicleId: req.params.id 
        }).sort({ date: -1 });
        
        res.json(logs);
    } catch (error) {
        console.error('Error fetching maintenance logs:', error);
        res.status(500).json({ message: 'Failed to fetch maintenance logs' });
    }
});

// GET a specific log entry
app.get('/api/logs/:id', async (req, res) => {
    try {
        const log = await MaintenanceLog.findById(req.params.id);
        
        if (!log) {
            return res.status(404).json({ message: 'Maintenance log not found' });
        }
        
        res.json(log);
    } catch (error) {
        console.error('Error fetching maintenance log:', error);
        res.status(500).json({ message: 'Failed to fetch maintenance log' });
    }
});

// POST a new maintenance log
function maintenanceLogToPgData(doc, pgVehicleId) {
    return {
        vehicleId: pgVehicleId,
        date: doc.date,
        description: doc.description,
        odometer: doc.odometer,
        nextServiceMileage: doc.nextServiceMileage ?? null,
        serviceProvider: doc.serviceProvider ?? null,
        cost: doc.cost ?? null,
        nextServiceDue: doc.nextServiceDue ?? null,
        notes: doc.notes ?? null,
    };
}

// Applies the same lastService/nextService/currentMileage patch to the
// Postgres Vehicle row, skipping silently if that vehicle isn't in
// Postgres yet (dual-write hasn't backfilled/created it).
async function dualWriteVehicleServiceUpdate(mongoVehicleId, data) {
    if (!isDualWriteEnabled('vehicles')) return;
    const pgVehicleId = await getPgVehicleId(mongoVehicleId);
    if (!pgVehicleId) return;
    try {
        await prisma.vehicle.update({ where: { id: pgVehicleId }, data });
    } catch (err) {
        console.error(`[Postgres dual-write] vehicles service-update failed for mongoId=${mongoVehicleId}:`, err.message);
    }
}

app.post('/api/logs', async (req, res) => {
    try {

        req.body.nextServiceMileage = req.body.odometer + 7000;

        const newLog = new MaintenanceLog(req.body);
        const savedLog = await newLog.save();

        // Update vehicle with latest service information
        await Vehicle.findByIdAndUpdate(req.body.vehicleId, {
            lastService: req.body.date,
            nextService: req.body.nextServiceDue,
            currentMileage: req.body.odometer
        });

        if (isDualWriteEnabled('maintenanceLogs')) {
            const pgVehicleId = await getPgVehicleId(savedLog.vehicleId);
            if (pgVehicleId) {
                await dualWriteUpsert('maintenanceLogs', prisma.maintenanceLog, savedLog._id.toString(), maintenanceLogToPgData(savedLog, pgVehicleId));
            } else {
                console.error(`[Postgres dual-write] maintenanceLogs upsert skipped for mongoId=${savedLog._id}: vehicle mongoId=${savedLog.vehicleId} not found in Postgres`);
            }
        }
        await dualWriteVehicleServiceUpdate(req.body.vehicleId, {
            lastService: req.body.date,
            nextService: req.body.nextServiceDue,
            currentMileage: req.body.odometer,
        });

        res.status(201).json(savedLog);
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

        const updatedLog = await MaintenanceLog.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedLog) {
            return res.status(404).json({ message: 'Maintenance log not found' });
        }

        // Update vehicle with latest service information if this is the most recent log
        const mostRecentLog = await MaintenanceLog.findOne({
            vehicleId: updatedLog.vehicleId
        }).sort({ date: -1 });

        let vehicleServiceUpdated = false;
        if (mostRecentLog && mostRecentLog._id.toString() === updatedLog._id.toString()) {
            await Vehicle.findByIdAndUpdate(updatedLog.vehicleId, {
                lastService: updatedLog.date,
                nextService: updatedLog.nextServiceDue,
                currentMileage: updatedLog.odometer
            });
            vehicleServiceUpdated = true;
        }

        if (isDualWriteEnabled('maintenanceLogs')) {
            const pgVehicleId = await getPgVehicleId(updatedLog.vehicleId);
            if (pgVehicleId) {
                await dualWriteUpsert('maintenanceLogs', prisma.maintenanceLog, updatedLog._id.toString(), maintenanceLogToPgData(updatedLog, pgVehicleId));
            } else {
                console.error(`[Postgres dual-write] maintenanceLogs upsert skipped for mongoId=${updatedLog._id}: vehicle mongoId=${updatedLog.vehicleId} not found in Postgres`);
            }
        }
        if (vehicleServiceUpdated) {
            await dualWriteVehicleServiceUpdate(updatedLog.vehicleId, {
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
        const log = await MaintenanceLog.findById(req.params.id);

        if (!log) {
            return res.status(404).json({ message: 'Maintenance log not found' });
        }

        const deletedLog = await MaintenanceLog.findByIdAndDelete(req.params.id);

        // Update vehicle's last service information if needed
        const mostRecentLog = await MaintenanceLog.findOne({
            vehicleId: log.vehicleId
        }).sort({ date: -1 });

        if (mostRecentLog) {
            await Vehicle.findByIdAndUpdate(log.vehicleId, {
                lastService: mostRecentLog.date,
                nextService: mostRecentLog.nextServiceDue
            });
        } else {
            // No logs left, clear the service dates
            await Vehicle.findByIdAndUpdate(log.vehicleId, {
                lastService: null,
                nextService: null
            });
        }

        await dualWriteDelete('maintenanceLogs', prisma.maintenanceLog, req.params.id);
        if (mostRecentLog) {
            await dualWriteVehicleServiceUpdate(log.vehicleId, {
                lastService: mostRecentLog.date,
                nextService: mostRecentLog.nextServiceDue,
            });
        } else {
            await dualWriteVehicleServiceUpdate(log.vehicleId, {
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
        const taxes = await RoadTax.find({ 
            vehicleId: req.params.id 
        }).sort({ expiryDate: -1 });
        
        res.json(taxes);
    } catch (error) {
        console.error('Error fetching road tax logs:', error);
        res.status(500).json({ message: 'Failed to fetch road tax logs' });
    }
});

// GET a specific road tax entry
app.get('/api/taxes/:id', async (req, res) => {
    try {
        const tax = await RoadTax.findById(req.params.id);
        
        if (!tax) {
            return res.status(404).json({ message: 'Road tax entry not found' });
        }
        
        res.json(tax);
    } catch (error) {
        console.error('Error fetching road tax entry:', error);
        res.status(500).json({ message: 'Failed to fetch road tax entry' });
    }
});

// POST a new road tax entry
// Shared dual-write for the 4 simple vehicle-child models (RoadTax, FuelLog,
// Insurance, Location) - none of these have Vehicle-side side effects like
// MaintenanceLog does, so create/update both just need vehicleId resolved
// and upserted; delete just needs the mongoId.
async function dualWriteChildUpsert(collectionName, prismaModel, doc, dataWithoutVehicleId) {
    if (!isDualWriteEnabled(collectionName)) return;
    const pgVehicleId = await getPgVehicleId(doc.vehicleId);
    if (!pgVehicleId) {
        console.error(`[Postgres dual-write] ${collectionName} upsert skipped for mongoId=${doc._id}: vehicle mongoId=${doc.vehicleId} not found in Postgres`);
        return;
    }
    await dualWriteUpsert(collectionName, prismaModel, doc._id.toString(), { vehicleId: pgVehicleId, ...dataWithoutVehicleId });
}

function roadTaxToPgData(doc) {
    return {
        taxId: doc.taxId,
        renewalDate: doc.renewalDate,
        expiryDate: doc.expiryDate,
        cost: doc.cost,
        agent: doc.agent ?? null,
        notes: doc.notes ?? null,
    };
}

app.post('/api/taxes', async (req, res) => {
    try {
        const newTax = new RoadTax(req.body);
        const savedTax = await newTax.save();

        await dualWriteChildUpsert('roadTaxes', prisma.roadTax, savedTax, roadTaxToPgData(savedTax));

        res.status(201).json(savedTax);
    } catch (error) {
        console.error('Error adding road tax entry:', error);
        res.status(500).json({ message: 'Failed to add road tax entry' });
    }
});

// PUT (update) a road tax entry
app.put('/api/taxes/:id', async (req, res) => {
    try {
        const updatedTax = await RoadTax.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedTax) {
            return res.status(404).json({ message: 'Road tax entry not found' });
        }

        await dualWriteChildUpsert('roadTaxes', prisma.roadTax, updatedTax, roadTaxToPgData(updatedTax));

        res.json(updatedTax);
    } catch (error) {
        console.error('Error updating road tax entry:', error);
        res.status(500).json({ message: 'Failed to update road tax entry' });
    }
});

// DELETE a road tax entry
app.delete('/api/taxes/:id', async (req, res) => {
    try {
        const deletedTax = await RoadTax.findByIdAndDelete(req.params.id);

        if (!deletedTax) {
            return res.status(404).json({ message: 'Road tax entry not found' });
        }

        await dualWriteDelete('roadTaxes', prisma.roadTax, req.params.id);

        res.json({ message: 'Road tax entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting road tax entry:', error);
        res.status(500).json({ message: 'Failed to delete road tax entry' });
    }
});

// GET fuel logs for a vehicle
app.get('/api/vehicles/:id/fuel', async (req, res) => {
    try {
        const fuelLogs = await FuelLog.find({ 
            vehicleId: req.params.id 
        }).sort({ date: -1 });
        
        res.json(fuelLogs);
    } catch (error) {
        console.error('Error fetching fuel logs:', error);
        res.status(500).json({ message: 'Failed to fetch fuel logs' });
    }
});

// GET a specific fuel log entry
app.get('/api/fuel/:id', async (req, res) => {
    try {
        const fuelLog = await FuelLog.findById(req.params.id);
        
        if (!fuelLog) {
            return res.status(404).json({ message: 'Fuel log entry not found' });
        }
        
        res.json(fuelLog);
    } catch (error) {
        console.error('Error fetching fuel log entry:', error);
        res.status(500).json({ message: 'Failed to fetch fuel log entry' });
    }
});

function fuelLogToPgData(doc) {
    return {
        receiptNumber: doc.receiptNumber,
        date: doc.date,
        driver: doc.driver,
        cost: doc.cost,
        amount: doc.amount,
        notes: doc.notes ?? null,
    };
}

// POST a new fuel log entry
app.post('/api/fuel', async (req, res) => {
    try {
        const newFuelLog = new FuelLog(req.body);
        const savedFuelLog = await newFuelLog.save();

        await dualWriteChildUpsert('fuelLogs', prisma.fuelLog, savedFuelLog, fuelLogToPgData(savedFuelLog));

        res.status(201).json(savedFuelLog);
    } catch (error) {
        console.error('Error adding fuel log entry:', error);
        res.status(500).json({ message: 'Failed to add fuel log entry' });
    }
});

// PUT (update) a fuel log entry
app.put('/api/fuel/:id', async (req, res) => {
    try {
        const updatedFuelLog = await FuelLog.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedFuelLog) {
            return res.status(404).json({ message: 'Fuel log entry not found' });
        }

        await dualWriteChildUpsert('fuelLogs', prisma.fuelLog, updatedFuelLog, fuelLogToPgData(updatedFuelLog));

        res.json(updatedFuelLog);
    } catch (error) {
        console.error('Error updating fuel log entry:', error);
        res.status(500).json({ message: 'Failed to update fuel log entry' });
    }
});

// DELETE a fuel log entry
app.delete('/api/fuel/:id', async (req, res) => {
    try {
        const deletedFuelLog = await FuelLog.findByIdAndDelete(req.params.id);

        if (!deletedFuelLog) {
            return res.status(404).json({ message: 'Fuel log entry not found' });
        }

        await dualWriteDelete('fuelLogs', prisma.fuelLog, req.params.id);

        res.json({ message: 'Fuel log entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting fuel log entry:', error);
        res.status(500).json({ message: 'Failed to delete fuel log entry' });
    }
});

// GET insurance logs for a vehicle
app.get('/api/vehicles/:id/insurance', async (req, res) => {
    try {
        const insuranceLogs = await Insurance.find({ 
            vehicleId: req.params.id 
        }).sort({ expiryDate: -1 });
        
        res.json(insuranceLogs);
    } catch (error) {
        console.error('Error fetching insurance logs:', error);
        res.status(500).json({ message: 'Failed to fetch insurance logs' });
    }
});

// GET a specific insurance entry
app.get('/api/insurance/:id', async (req, res) => {
    try {
        const insurance = await Insurance.findById(req.params.id);
        
        if (!insurance) {
            return res.status(404).json({ message: 'Insurance entry not found' });
        }
        
        res.json(insurance);
    } catch (error) {
        console.error('Error fetching insurance entry:', error);
        res.status(500).json({ message: 'Failed to fetch insurance entry' });
    }
});

// POST a new insurance entry
function insuranceToPgData(doc) {
    return {
        insuranceId: doc.insuranceId,
        provider: doc.provider,
        renewalDate: doc.renewalDate,
        expiryDate: doc.expiryDate,
        cost: doc.cost,
        agent: doc.agent ?? null,
        notes: doc.notes ?? null,
    };
}

app.post('/api/insurance', async (req, res) => {
    try {
        const newInsurance = new Insurance(req.body);
        const savedInsurance = await newInsurance.save();

        await dualWriteChildUpsert('insurances', prisma.insurance, savedInsurance, insuranceToPgData(savedInsurance));

        res.status(201).json(savedInsurance);
    } catch (error) {
        console.error('Error adding insurance entry:', error);
        res.status(500).json({ message: 'Failed to add insurance entry' });
    }
});

// PUT (update) an insurance entry
app.put('/api/insurance/:id', async (req, res) => {
    try {
        const updatedInsurance = await Insurance.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedInsurance) {
            return res.status(404).json({ message: 'Insurance entry not found' });
        }

        await dualWriteChildUpsert('insurances', prisma.insurance, updatedInsurance, insuranceToPgData(updatedInsurance));

        res.json(updatedInsurance);
    } catch (error) {
        console.error('Error updating insurance entry:', error);
        res.status(500).json({ message: 'Failed to update insurance entry' });
    }
});

// DELETE an insurance entry
app.delete('/api/insurance/:id', async (req, res) => {
    try {
        const deletedInsurance = await Insurance.findByIdAndDelete(req.params.id);

        if (!deletedInsurance) {
            return res.status(404).json({ message: 'Insurance entry not found' });
        }

        await dualWriteDelete('insurances', prisma.insurance, req.params.id);

        res.json({ message: 'Insurance entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting insurance entry:', error);
        res.status(500).json({ message: 'Failed to delete insurance entry' });
    }
});

// GET location logs for a vehicle
app.get('/api/vehicles/:id/locations', async (req, res) => {
    try {
        console.log(`Fetching locations for vehicle ${req.params.id}`);
        const locations = await Location.find({ 
            vehicleId: req.params.id 
        }).sort({ fromDate: -1 });
        
        console.log(`Found ${locations.length} location records`);
        res.json(locations);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Failed to fetch location logs' });
    }
});


// GET a specific location entry
app.get('/api/locations/:id', async (req, res) => {
    try {
        const location = await Location.findById(req.params.id);
        
        if (!location) {
            return res.status(404).json({ message: 'Location entry not found' });
        }
        
        res.json(location);
    } catch (error) {
        console.error('Error fetching location entry:', error);
        res.status(500).json({ message: 'Failed to fetch location entry' });
    }
});

function locationToPgData(doc) {
    return {
        fromDate: doc.fromDate,
        toDate: doc.toDate,
        location: doc.location,
        agent: doc.agent ?? null,
        notes: doc.notes ?? null,
    };
}

// POST a new location entry
app.post('/api/locations', async (req, res) => {
    try {
        const newLocation = new Location(req.body);
        const savedLocation = await newLocation.save();

        await dualWriteChildUpsert('locations', prisma.location, savedLocation, locationToPgData(savedLocation));

        res.status(201).json(savedLocation);
    } catch (error) {
        console.error('Error adding location entry:', error);
        res.status(500).json({ message: 'Failed to add location entry' });
    }
});

// PUT (update) a location entry
app.put('/api/locations/:id', async (req, res) => {
    try {
        const updatedLocation = await Location.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updatedLocation) {
            return res.status(404).json({ message: 'Location entry not found' });
        }

        await dualWriteChildUpsert('locations', prisma.location, updatedLocation, locationToPgData(updatedLocation));

        res.json(updatedLocation);
    } catch (error) {
        console.error('Error updating location entry:', error);
        res.status(500).json({ message: 'Failed to update location entry' });
    }
});

// DELETE a location entry
app.delete('/api/locations/:id', async (req, res) => {
    try {
        const deletedLocation = await Location.findByIdAndDelete(req.params.id);

        if (!deletedLocation) {
            return res.status(404).json({ message: 'Location entry not found' });
        }

        await dualWriteDelete('locations', prisma.location, req.params.id);

        res.json({ message: 'Location entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting location entry:', error);
        res.status(500).json({ message: 'Failed to delete location entry' });
    }
});

app.get('/api/mileage/latest', async (req, res) => {
    try {
        const { vehicleId } = req.query;
        const latestMileage = await MileageLog.findOne({ 
            vehicleId 
        }).sort({ date: -1 });
        
        res.json(latestMileage);
    } catch (error) {
        console.error('Error fetching latest mileage:', error);
        res.status(500).json({ message: 'Failed to fetch latest mileage' });
    }
});

app.get('/api/vehicles/:id/mileage/history', async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const { startDate, endDate } = req.query;
        
        let query = { vehicleId };
        
        if (startDate && endDate) {
            query.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }
        
        const mileageLogs = await MileageLog.find(query)
            .sort({ date: -1 })
            .populate('vehicleId', 'make model plate');
        
        res.json(mileageLogs);
    } catch (error) {
        console.error('Error fetching mileage history:', error);
        res.status(500).json({ message: 'Failed to fetch mileage history' });
    }
});

// POST a new mileage log entry
app.post('/api/mileage', async (req, res) => {
    try {
        const newMileageLog = new MileageLog(req.body);
        const savedMileageLog = await newMileageLog.save();

        // REMOVED the vehicle update - only log mileage, don't update vehicle
        // await Vehicle.findByIdAndUpdate(req.body.vehicleId, {
        //     currentMileage: req.body.mileage
        // });

        await dualWriteChildUpsert('mileageLogs', prisma.mileageLog, savedMileageLog, {
            date: savedMileageLog.date,
            mileage: savedMileageLog.mileage,
            notes: savedMileageLog.notes ?? null,
        });

        res.status(201).json(savedMileageLog);
    } catch (error) {
        console.error('Error adding mileage log:', error);
        res.status(500).json({ message: 'Failed to add mileage log' });
    }
});

// GET all mileage logs for a vehicle
app.get('/api/vehicles/:id/mileage', async (req, res) => {
    try {
        const mileageLogs = await MileageLog.find({ 
            vehicleId: req.params.id 
        }).sort({ date: -1 });
        
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
        
        // Find mileage log for the specific date
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        
        const mileageLog = await MileageLog.findOne({
            vehicleId: vehicleId,
            date: {
                $gte: startOfDay,
                $lte: endOfDay
            }
        });
        
        res.json(mileageLog);
    } catch (error) {
        console.error('Error fetching mileage by date:', error);
        res.status(500).json({ message: 'Failed to fetch mileage data' });
    }
});



app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));  // Changed path
  });
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the app at: http://localhost:${PORT}`);
  });