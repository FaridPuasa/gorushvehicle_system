// Postgres-backed data-access layer for gorushvehicle_system, replacing
// every Mongoose model/query in server.js. Cut over 2026-09-18 after
// confirming full parity with the Mongo collections this app used to be
// primary on (Vehicle 12/12, MaintenanceLog 127/127, RoadTax 47/47,
// Insurance 52/52, MileageLog 2098/2098, FuelLog/Location both genuinely
// empty) via its own dual-write mirror (dualWrite.js, now retired).
//
// `_id` stays the exposed key on every record (a generated 24-hex-char
// string, cosmetically Mongo-ObjectId-shaped via generateMongoIdShape() -
// zero I/O, no real Mongo document behind it anymore) since add-logs.html/
// script.js already treat it as an opaque string identifier - confirmed via
// grep, no ObjectId-format validation exists client-side. Stored in the
// `mongoId` column, which doubles as the cross-reference every child
// table's `vehicleId` foreign key is resolved through in this API layer.
const crypto = require('crypto');
const prisma = require('./prismaClient');

function generateMongoIdShape() {
    return crypto.randomBytes(12).toString('hex');
}

function toNum(value) {
    return value === null || value === undefined ? value : Number(value);
}

// Mongoose coerced date-only strings ("YYYY-MM-DD") into Dates automatically;
// Prisma's DateTime scalar requires full ISO-8601 and rejects them, so every
// date field coming from a request body must be converted explicitly.
function toDate(value) {
    return value === null || value === undefined ? value : new Date(value);
}

function toApiVehicle(row) {
    return {
        _id: row.mongoId,
        year: row.year,
        make: row.make,
        model: row.model,
        plate: row.plate,
        engine: row.engine,
        chasis: row.chasis,
        status: row.status,
        fuelType: row.fuelType,
        acquisitionDate: row.acquisitionDate,
        currentMileage: toNum(row.currentMileage),
        lastService: row.lastService,
        nextService: row.nextService,
        createdAt: row.createdAt,
    };
}

function toApiMaintenanceLog(row) {
    return {
        _id: row.mongoId,
        vehicleId: row.vehicle.mongoId,
        date: row.date,
        description: row.description,
        odometer: toNum(row.odometer),
        nextServiceMileage: toNum(row.nextServiceMileage),
        serviceProvider: row.serviceProvider,
        cost: toNum(row.cost),
        nextServiceDue: row.nextServiceDue,
        notes: row.notes,
        createdAt: row.createdAt,
    };
}

function toApiRoadTax(row) {
    return {
        _id: row.mongoId,
        vehicleId: row.vehicle.mongoId,
        taxId: row.taxId,
        renewalDate: row.renewalDate,
        expiryDate: row.expiryDate,
        cost: toNum(row.cost),
        agent: row.agent,
        notes: row.notes,
        createdAt: row.createdAt,
    };
}

function toApiFuelLog(row) {
    return {
        _id: row.mongoId,
        vehicleId: row.vehicle.mongoId,
        receiptNumber: row.receiptNumber,
        date: row.date,
        driver: row.driver,
        cost: toNum(row.cost),
        amount: row.amount,
        notes: row.notes,
        createdAt: row.createdAt,
    };
}

function toApiInsurance(row) {
    return {
        _id: row.mongoId,
        vehicleId: row.vehicle.mongoId,
        insuranceId: row.insuranceId,
        provider: row.provider,
        renewalDate: row.renewalDate,
        expiryDate: row.expiryDate,
        cost: toNum(row.cost),
        agent: row.agent,
        notes: row.notes,
        createdAt: row.createdAt,
    };
}

function toApiLocation(row) {
    return {
        _id: row.mongoId,
        vehicleId: row.vehicle.mongoId,
        fromDate: row.fromDate,
        toDate: row.toDate,
        location: row.location,
        agent: row.agent,
        notes: row.notes,
        createdAt: row.createdAt,
    };
}

function toApiMileageLog(row) {
    return {
        _id: row.mongoId,
        vehicleId: row.vehicle.mongoId,
        date: row.date,
        mileage: toNum(row.mileage),
        notes: row.notes,
        createdAt: row.createdAt,
    };
}

const CHILD_INCLUDE = { vehicle: { select: { mongoId: true } } };

// Resolves a client-supplied vehicleId (the mongoId-shaped string) to the
// real Postgres vehicle row. Every child create/update route needs this.
async function findPgVehicleByMongoId(vehicleMongoId) {
    return prisma.vehicle.findUnique({ where: { mongoId: String(vehicleMongoId) } });
}

// --- Vehicle ---

async function findAllVehicles() {
    const rows = await prisma.vehicle.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toApiVehicle);
}

async function findVehicleById(mongoId) {
    const row = await prisma.vehicle.findUnique({ where: { mongoId: String(mongoId) } });
    return row ? toApiVehicle(row) : null;
}

async function createVehicle(data) {
    const row = await prisma.vehicle.create({
        data: {
            mongoId: generateMongoIdShape(),
            year: data.year ?? null,
            make: data.make ?? null,
            model: data.model ?? null,
            plate: data.plate,
            engine: data.engine ?? null,
            chasis: data.chasis ?? null,
            status: data.status || 'active',
            fuelType: data.fuelType ?? null,
            acquisitionDate: toDate(data.acquisitionDate) ?? null,
            currentMileage: data.currentMileage ?? 0,
            lastService: toDate(data.lastService) ?? null,
            nextService: toDate(data.nextService) ?? null,
        },
    });
    return toApiVehicle(row);
}

async function updateVehicle(mongoId, data) {
    const existing = await findPgVehicleByMongoId(mongoId);
    if (!existing) return null;
    const row = await prisma.vehicle.update({
        where: { id: existing.id },
        data: {
            year: data.year, make: data.make, model: data.model, plate: data.plate,
            engine: data.engine, chasis: data.chasis, status: data.status, fuelType: data.fuelType,
            acquisitionDate: toDate(data.acquisitionDate), currentMileage: data.currentMileage,
            lastService: toDate(data.lastService), nextService: toDate(data.nextService),
        },
    });
    return toApiVehicle(row);
}

// Cascade delete (onDelete: Cascade on every child table's vehicleId FK)
// handles all associated records automatically - no manual per-table
// deletes needed, unlike the old Mongo code.
async function deleteVehicle(mongoId) {
    const existing = await findPgVehicleByMongoId(mongoId);
    if (!existing) return null;
    await prisma.vehicle.delete({ where: { id: existing.id } });
    return existing;
}

// Applies a lastService/nextService/currentMileage patch directly (used by
// the maintenance-log create/update/delete side effects below).
async function updateVehicleServiceInfo(vehicleMongoId, data) {
    const existing = await findPgVehicleByMongoId(vehicleMongoId);
    if (!existing) return null;
    return prisma.vehicle.update({
        where: { id: existing.id },
        data: { ...data, lastService: toDate(data.lastService), nextService: toDate(data.nextService) },
    });
}

// --- MaintenanceLog ---

async function findMaintenanceLogsForVehicle(vehicleMongoId) {
    const rows = await prisma.maintenanceLog.findMany({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { date: 'desc' },
        include: CHILD_INCLUDE,
    });
    return rows.map(toApiMaintenanceLog);
}

async function findMaintenanceLogById(mongoId) {
    const row = await prisma.maintenanceLog.findUnique({ where: { mongoId: String(mongoId) }, include: CHILD_INCLUDE });
    return row ? toApiMaintenanceLog(row) : null;
}

async function findMostRecentMaintenanceLog(vehicleMongoId) {
    const row = await prisma.maintenanceLog.findFirst({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { date: 'desc' },
        include: CHILD_INCLUDE,
    });
    return row ? toApiMaintenanceLog(row) : null;
}

async function createMaintenanceLog(data) {
    const vehicle = await findPgVehicleByMongoId(data.vehicleId);
    if (!vehicle) return { error: 'vehicle_not_found' };
    const row = await prisma.maintenanceLog.create({
        data: {
            mongoId: generateMongoIdShape(),
            vehicleId: vehicle.id,
            date: toDate(data.date),
            description: data.description,
            odometer: data.odometer,
            nextServiceMileage: data.nextServiceMileage ?? null,
            serviceProvider: data.serviceProvider ?? null,
            cost: data.cost ?? null,
            nextServiceDue: toDate(data.nextServiceDue) ?? null,
            notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return { log: toApiMaintenanceLog(row) };
}

async function updateMaintenanceLog(mongoId, data) {
    const existing = await prisma.maintenanceLog.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    const row = await prisma.maintenanceLog.update({
        where: { id: existing.id },
        data: {
            date: toDate(data.date), description: data.description, odometer: data.odometer,
            nextServiceMileage: data.nextServiceMileage ?? null, serviceProvider: data.serviceProvider ?? null,
            cost: data.cost ?? null, nextServiceDue: toDate(data.nextServiceDue) ?? null, notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return toApiMaintenanceLog(row);
}

async function deleteMaintenanceLog(mongoId) {
    const existing = await prisma.maintenanceLog.findUnique({ where: { mongoId: String(mongoId) }, include: CHILD_INCLUDE });
    if (!existing) return null;
    await prisma.maintenanceLog.delete({ where: { id: existing.id } });
    return toApiMaintenanceLog(existing);
}

// --- RoadTax ---

async function findRoadTaxesForVehicle(vehicleMongoId) {
    const rows = await prisma.roadTax.findMany({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { expiryDate: 'desc' },
        include: CHILD_INCLUDE,
    });
    return rows.map(toApiRoadTax);
}

async function findRoadTaxById(mongoId) {
    const row = await prisma.roadTax.findUnique({ where: { mongoId: String(mongoId) }, include: CHILD_INCLUDE });
    return row ? toApiRoadTax(row) : null;
}

async function createRoadTax(data) {
    const vehicle = await findPgVehicleByMongoId(data.vehicleId);
    if (!vehicle) return { error: 'vehicle_not_found' };
    const row = await prisma.roadTax.create({
        data: {
            mongoId: generateMongoIdShape(), vehicleId: vehicle.id,
            taxId: data.taxId, renewalDate: toDate(data.renewalDate), expiryDate: toDate(data.expiryDate),
            cost: data.cost, agent: data.agent ?? null, notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return { entry: toApiRoadTax(row) };
}

async function updateRoadTax(mongoId, data) {
    const existing = await prisma.roadTax.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    const row = await prisma.roadTax.update({
        where: { id: existing.id },
        data: { taxId: data.taxId, renewalDate: toDate(data.renewalDate), expiryDate: toDate(data.expiryDate), cost: data.cost, agent: data.agent ?? null, notes: data.notes ?? null },
        include: CHILD_INCLUDE,
    });
    return toApiRoadTax(row);
}

async function deleteRoadTax(mongoId) {
    const existing = await prisma.roadTax.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    await prisma.roadTax.delete({ where: { id: existing.id } });
    return existing;
}

// --- FuelLog ---

async function findFuelLogsForVehicle(vehicleMongoId) {
    const rows = await prisma.fuelLog.findMany({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { date: 'desc' },
        include: CHILD_INCLUDE,
    });
    return rows.map(toApiFuelLog);
}

async function findFuelLogById(mongoId) {
    const row = await prisma.fuelLog.findUnique({ where: { mongoId: String(mongoId) }, include: CHILD_INCLUDE });
    return row ? toApiFuelLog(row) : null;
}

async function createFuelLog(data) {
    const vehicle = await findPgVehicleByMongoId(data.vehicleId);
    if (!vehicle) return { error: 'vehicle_not_found' };
    const row = await prisma.fuelLog.create({
        data: {
            mongoId: generateMongoIdShape(), vehicleId: vehicle.id,
            receiptNumber: data.receiptNumber, date: toDate(data.date), driver: data.driver,
            cost: data.cost, amount: data.amount, notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return { entry: toApiFuelLog(row) };
}

async function updateFuelLog(mongoId, data) {
    const existing = await prisma.fuelLog.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    const row = await prisma.fuelLog.update({
        where: { id: existing.id },
        data: { receiptNumber: data.receiptNumber, date: toDate(data.date), driver: data.driver, cost: data.cost, amount: data.amount, notes: data.notes ?? null },
        include: CHILD_INCLUDE,
    });
    return toApiFuelLog(row);
}

async function deleteFuelLog(mongoId) {
    const existing = await prisma.fuelLog.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    await prisma.fuelLog.delete({ where: { id: existing.id } });
    return existing;
}

// --- Insurance ---

async function findInsurancesForVehicle(vehicleMongoId) {
    const rows = await prisma.insurance.findMany({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { expiryDate: 'desc' },
        include: CHILD_INCLUDE,
    });
    return rows.map(toApiInsurance);
}

async function findInsuranceById(mongoId) {
    const row = await prisma.insurance.findUnique({ where: { mongoId: String(mongoId) }, include: CHILD_INCLUDE });
    return row ? toApiInsurance(row) : null;
}

async function createInsurance(data) {
    const vehicle = await findPgVehicleByMongoId(data.vehicleId);
    if (!vehicle) return { error: 'vehicle_not_found' };
    const row = await prisma.insurance.create({
        data: {
            mongoId: generateMongoIdShape(), vehicleId: vehicle.id,
            insuranceId: data.insuranceId, provider: data.provider, renewalDate: toDate(data.renewalDate), expiryDate: toDate(data.expiryDate),
            cost: data.cost, agent: data.agent ?? null, notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return { entry: toApiInsurance(row) };
}

async function updateInsurance(mongoId, data) {
    const existing = await prisma.insurance.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    const row = await prisma.insurance.update({
        where: { id: existing.id },
        data: { insuranceId: data.insuranceId, provider: data.provider, renewalDate: toDate(data.renewalDate), expiryDate: toDate(data.expiryDate), cost: data.cost, agent: data.agent ?? null, notes: data.notes ?? null },
        include: CHILD_INCLUDE,
    });
    return toApiInsurance(row);
}

async function deleteInsurance(mongoId) {
    const existing = await prisma.insurance.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    await prisma.insurance.delete({ where: { id: existing.id } });
    return existing;
}

// --- Location ---

async function findLocationsForVehicle(vehicleMongoId) {
    const rows = await prisma.location.findMany({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { fromDate: 'desc' },
        include: CHILD_INCLUDE,
    });
    return rows.map(toApiLocation);
}

async function findLocationById(mongoId) {
    const row = await prisma.location.findUnique({ where: { mongoId: String(mongoId) }, include: CHILD_INCLUDE });
    return row ? toApiLocation(row) : null;
}

async function createLocation(data) {
    const vehicle = await findPgVehicleByMongoId(data.vehicleId);
    if (!vehicle) return { error: 'vehicle_not_found' };
    const row = await prisma.location.create({
        data: {
            mongoId: generateMongoIdShape(), vehicleId: vehicle.id,
            fromDate: toDate(data.fromDate), toDate: toDate(data.toDate), location: data.location,
            agent: data.agent ?? null, notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return { entry: toApiLocation(row) };
}

async function updateLocation(mongoId, data) {
    const existing = await prisma.location.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    const row = await prisma.location.update({
        where: { id: existing.id },
        data: { fromDate: toDate(data.fromDate), toDate: toDate(data.toDate), location: data.location, agent: data.agent ?? null, notes: data.notes ?? null },
        include: CHILD_INCLUDE,
    });
    return toApiLocation(row);
}

async function deleteLocation(mongoId) {
    const existing = await prisma.location.findUnique({ where: { mongoId: String(mongoId) } });
    if (!existing) return null;
    await prisma.location.delete({ where: { id: existing.id } });
    return existing;
}

// --- MileageLog ---

async function findLatestMileage(vehicleMongoId) {
    const row = await prisma.mileageLog.findFirst({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { date: 'desc' },
        include: CHILD_INCLUDE,
    });
    return row ? toApiMileageLog(row) : null;
}

async function findAllMileageForVehicle(vehicleMongoId) {
    const rows = await prisma.mileageLog.findMany({
        where: { vehicle: { mongoId: String(vehicleMongoId) } },
        orderBy: { date: 'desc' },
        include: CHILD_INCLUDE,
    });
    return rows.map(toApiMileageLog);
}

// Not currently called by script.js (confirmed via grep) - kept for API
// completeness. Mongoose's `.populate('vehicleId', 'make model plate')` is
// NOT replicated here since nothing consumes that shape; vehicleId stays a
// plain mongoId string like every other endpoint.
async function findMileageHistory(vehicleMongoId, startDate, endDate) {
    const where = { vehicle: { mongoId: String(vehicleMongoId) } };
    if (startDate && endDate) {
        where.date = { gte: new Date(startDate), lte: new Date(endDate) };
    }
    const rows = await prisma.mileageLog.findMany({ where, orderBy: { date: 'desc' }, include: CHILD_INCLUDE });
    return rows.map(toApiMileageLog);
}

async function findMileageByDate(vehicleMongoId, date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    const row = await prisma.mileageLog.findFirst({
        where: { vehicle: { mongoId: String(vehicleMongoId) }, date: { gte: startOfDay, lte: endOfDay } },
        include: CHILD_INCLUDE,
    });
    return row ? toApiMileageLog(row) : null;
}

async function createMileageLog(data) {
    const vehicle = await findPgVehicleByMongoId(data.vehicleId);
    if (!vehicle) return { error: 'vehicle_not_found' };
    const row = await prisma.mileageLog.create({
        data: {
            mongoId: generateMongoIdShape(), vehicleId: vehicle.id,
            date: toDate(data.date), mileage: data.mileage, notes: data.notes ?? null,
        },
        include: CHILD_INCLUDE,
    });
    return { entry: toApiMileageLog(row) };
}

module.exports = {
    findAllVehicles, findVehicleById, createVehicle, updateVehicle, deleteVehicle, updateVehicleServiceInfo,
    findMaintenanceLogsForVehicle, findMaintenanceLogById, findMostRecentMaintenanceLog, createMaintenanceLog, updateMaintenanceLog, deleteMaintenanceLog,
    findRoadTaxesForVehicle, findRoadTaxById, createRoadTax, updateRoadTax, deleteRoadTax,
    findFuelLogsForVehicle, findFuelLogById, createFuelLog, updateFuelLog, deleteFuelLog,
    findInsurancesForVehicle, findInsuranceById, createInsurance, updateInsurance, deleteInsurance,
    findLocationsForVehicle, findLocationById, createLocation, updateLocation, deleteLocation,
    findLatestMileage, findAllMileageForVehicle, findMileageHistory, findMileageByDate, createMileageLog,
};
