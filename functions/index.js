const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');

initializeApp();

exports.scheduledBackup = onSchedule(
  {
    schedule: '0 2 * * *',          // 2:00 AM every night
    timeZone: 'Asia/Kuala_Lumpur',  // MYT (UTC+8)
    region: 'asia-southeast1',
    memory: '256MiB',
    timeoutSeconds: 120,
  },
  async () => {
    const db      = getDatabase();
    const storage = getStorage();

    // Full DB snapshot
    const snapshot = await db.ref('/').once('value');
    const data     = snapshot.val();

    if (!data) {
      console.warn('Database returned empty snapshot — skipping backup.');
      return;
    }

    // e.g. backups/2026-07-20/iht-invoices-2026-07-20T020000.json
    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const path    = `backups/${dateStr}/iht-invoices-${dateStr}T${timeStr}.json`;

    const bucket  = storage.bucket('iht-invoices.firebasestorage.app');
    const file    = bucket.file(path);

    const payload = JSON.stringify(data, null, 2);
    await file.save(payload, {
      metadata: {
        contentType: 'application/json',
        metadata: { createdBy: 'scheduledBackup', project: 'iht-invoices' },
      },
    });

    const sizeKB = (Buffer.byteLength(payload) / 1024).toFixed(1);
    console.log(`Backup complete: ${path} (${sizeKB} KB)`);
  }
);
