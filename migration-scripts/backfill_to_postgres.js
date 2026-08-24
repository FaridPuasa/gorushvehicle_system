// One-off manual script, not part of the running app. Run with
// `node migration-scripts/backfill_to_postgres.js` from the project root.
// Pass --dry-run to log what would be created/updated without writing to
// Postgres. Idempotent - safe to run repeatedly (upserts keyed on mongoId).
//
// NOTE on --dry-run: it can only preview a child record's upsert (log,
// tax, fuel, insurance, location, mileage) if its parent Vehicle already
// exists in Postgres - a vehicle that --dry-run reports as "would create"
// has no real id yet to link children to, so those children show up as
// skippedNoVehicle in a dry run even though the real run will link them
// fine (Vehicle is always backfilled before its children, in the same run).
//
// Copies every existing Mongo document across all 7 fleet collections
// (Vehicle, MaintenanceLog, RoadTax, FuelLog, Insurance, Location,
// MileageLog) into the shared Supabase `vehicle` schema, so historical
// data isn't missing once dual-write (server.js) starts mirroring only
// *new* writes going forward. Must run Vehicle first - every child
// collection's vehicleId is resolved to the Postgres parent's row id via
// the mongoId cross-reference, so a vehicle needs to exist in Postgres
// before its children can be linked.
require('dotenv').config();
const mongoose = require('mongoose');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

const vehicleSchema = new mongoose.Schema({}, { strict: false });
const Vehicle = mongoose.model('Vehicle', vehicleSchema, 'vehicles');
const MaintenanceLog = mongoose.model('MaintenanceLog', vehicleSchema, 'maintenancelogs');
const RoadTax = mongoose.model('RoadTax', vehicleSchema, 'roadtaxes');
const FuelLog = mongoose.model('FuelLog', vehicleSchema, 'fuellogs');
const Insurance = mongoose.model('Insurance', vehicleSchema, 'insurances');
const Location = mongoose.model('Location', vehicleSchema, 'locations');
const MileageLog = mongoose.model('MileageLog', vehicleSchema, 'mileagelogs');

function n(v) { return v === undefined ? null : v; }

async function backfillVehicles() {
    const docs = await Vehicle.find({}).lean();
    console.log(`\nVehicle: ${docs.length} documents in Mongo`);
    const mongoIdToPgId = new Map();
    let created = 0, updated = 0;

    for (const doc of docs) {
        const mongoId = doc._id.toString();
        const data = {
            year: n(doc.year),
            make: n(doc.make),
            model: n(doc.model),
            plate: doc.plate,
            engine: n(doc.engine),
            chasis: n(doc.chasis),
            status: doc.status || 'active',
            fuelType: n(doc.fuelType),
            acquisitionDate: n(doc.acquisitionDate),
            currentMileage: doc.currentMileage ?? 0,
            lastService: n(doc.lastService),
            nextService: n(doc.nextService),
            createdAt: n(doc.createdAt),
        };

        if (DRY_RUN) {
            const existing = await prisma.vehicle.findUnique({ where: { mongoId }, select: { id: true } });
            if (existing) { updated++; mongoIdToPgId.set(mongoId, existing.id); }
            else created++;
            continue;
        }

        const row = await prisma.vehicle.upsert({
            where: { mongoId },
            create: { mongoId, ...data },
            update: data,
            select: { id: true },
        });
        mongoIdToPgId.set(mongoId, row.id);
    }

    if (DRY_RUN) console.log(`  wouldCreate=${created} wouldUpdate=${updated}`);
    else console.log(`  upserted=${mongoIdToPgId.size}`);
    return mongoIdToPgId;
}

async function backfillChildCollection(label, MongoModel, prismaModel, toPgData, vehicleIdMap) {
    const docs = await MongoModel.find({}).lean();
    console.log(`\n${label}: ${docs.length} documents in Mongo`);
    let upserted = 0, skippedNoVehicle = 0;

    for (const doc of docs) {
        const mongoVehicleId = doc.vehicleId ? doc.vehicleId.toString() : null;
        const pgVehicleId = mongoVehicleId ? vehicleIdMap.get(mongoVehicleId) : undefined;
        if (!pgVehicleId) {
            skippedNoVehicle++;
            continue;
        }
        const mongoId = doc._id.toString();
        const data = { vehicleId: pgVehicleId, ...toPgData(doc) };

        if (DRY_RUN) { upserted++; continue; }

        await prisma[prismaModel].upsert({
            where: { mongoId },
            create: { mongoId, ...data },
            update: data,
        });
        upserted++;
    }

    console.log(`  ${DRY_RUN ? 'wouldUpsert' : 'upserted'}=${upserted} skippedNoVehicle=${skippedNoVehicle}`);
}

async function main() {
    if (DRY_RUN) console.log('DRY RUN - no Postgres writes will be made.');
    await mongoose.connect(process.env.MONGODB_URI);

    const vehicleIdMap = await backfillVehicles();

    await backfillChildCollection('MaintenanceLog', MaintenanceLog, 'maintenanceLog', (doc) => ({
        date: doc.date,
        description: doc.description,
        odometer: doc.odometer,
        nextServiceMileage: n(doc.nextServiceMileage),
        serviceProvider: n(doc.serviceProvider),
        cost: n(doc.cost),
        nextServiceDue: n(doc.nextServiceDue),
        notes: n(doc.notes),
        createdAt: n(doc.createdAt),
    }), vehicleIdMap);

    await backfillChildCollection('RoadTax', RoadTax, 'roadTax', (doc) => ({
        taxId: doc.taxId,
        renewalDate: doc.renewalDate,
        expiryDate: doc.expiryDate,
        cost: doc.cost,
        agent: n(doc.agent),
        notes: n(doc.notes),
        createdAt: n(doc.createdAt),
    }), vehicleIdMap);

    await backfillChildCollection('FuelLog', FuelLog, 'fuelLog', (doc) => ({
        receiptNumber: doc.receiptNumber,
        date: doc.date,
        driver: doc.driver,
        cost: doc.cost,
        amount: doc.amount,
        notes: n(doc.notes),
        createdAt: n(doc.createdAt),
    }), vehicleIdMap);

    await backfillChildCollection('Insurance', Insurance, 'insurance', (doc) => ({
        insuranceId: doc.insuranceId,
        provider: doc.provider,
        renewalDate: doc.renewalDate,
        expiryDate: doc.expiryDate,
        cost: doc.cost,
        agent: n(doc.agent),
        notes: n(doc.notes),
        createdAt: n(doc.createdAt),
    }), vehicleIdMap);

    await backfillChildCollection('Location', Location, 'location', (doc) => ({
        fromDate: doc.fromDate,
        toDate: doc.toDate,
        location: doc.location,
        agent: n(doc.agent),
        notes: n(doc.notes),
        createdAt: n(doc.createdAt),
    }), vehicleIdMap);

    await backfillChildCollection('MileageLog', MileageLog, 'mileageLog', (doc) => ({
        date: doc.date,
        mileage: doc.mileage,
        notes: n(doc.notes),
        createdAt: n(doc.createdAt),
    }), vehicleIdMap);

    console.log('\nDONE.');
    await prisma.$disconnect();
    await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL ERROR:', e); process.exit(1); });
