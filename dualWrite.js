// Dual-write gate for this app's Mongo -> Supabase migration.
// Mirrors grfmxstatusupdate's data/dualWrite.js exactly.
//
// Two layers of control, both off by default:
//   SUPABASE_ENABLED                - master switch. false = no Postgres
//                                      write ever runs, full stop, regardless
//                                      of the per-collection list below.
//   SUPABASE_DUAL_WRITE_COLLECTIONS - comma-separated collection names
//                                      (matching the names used in
//                                      isDualWriteEnabled() calls) that
//                                      should actually dual-write once the
//                                      master switch is on.
//
// Postgres write failures are always caught and logged by the caller, never
// allowed to fail the Mongo write or the request - Mongo stays the sole
// source of truth until the read-cutover side of this migration is done.
function isDualWriteEnabled(collectionName) {
    if (process.env.SUPABASE_ENABLED !== 'true') return false;
    const enabledList = (process.env.SUPABASE_DUAL_WRITE_COLLECTIONS || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    return enabledList.includes(collectionName);
}

module.exports = { isDualWriteEnabled };
