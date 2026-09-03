import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool as PgPool, PoolClient } from 'pg';
import * as mysql from 'mysql2/promise';

export interface PushResult {
  table: string;
  rowsProcessed: number;
  rowsFailed: number;
  durationMs: number;
}

/**
 * Push-job: arah KEBALIKAN dari SyncService. Baca tabel staging native
 * Postgres (hasil aksi exhibitor app: approve/reject meeting, invite/
 * activate/remove member), tulis balik ke MySQL, tandai pushed_at.
 *
 * KENAPA HANYA 2 TABEL (bukan 3): chat SENGAJA tidak di-push. Exhibitor
 * app menulis langsung ke `chat_message` (Postgres native, tabel yang
 * sama dipakai visitor app) - lihat keputusan Sept 2026. Cuma meeting
 * approval & member status yang benar-benar perlu sampai ke MySQL,
 * karena admin panel PHP legacy masih baca events_meeting_v2 langsung.
 *
 * Pakai kredensial MySQL TERPISAH (MYSQL_SYNC_WRITER_USER/PASSWORD) -
 * user dengan write access dibatasi HANYA ke tabel yang relevan, BUKAN
 * user MYSQL_USER yang read-only dipakai SyncService untuk pull.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private mysqlPool: mysql.Pool;
  private pgPool: PgPool;
  private batchSize: number;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.batchSize = this.config.get<number>('PUSH_BATCH_SIZE', 200);

    this.mysqlPool = mysql.createPool({
      host: this.config.getOrThrow<string>('MYSQL_HOST'),
      port: this.config.get<number>('MYSQL_PORT', 3306),
      user: this.config.getOrThrow<string>('MYSQL_SYNC_WRITER_USER'),
      password: this.config.getOrThrow<string>('MYSQL_SYNC_WRITER_PASSWORD'),
      database: this.config.getOrThrow<string>('MYSQL_DATABASE'),
      connectionLimit: 3,
      idleTimeout: 60000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
    this.mysqlPool.on('connection', (conn) => {
      conn.on('error', (err) => {
        this.logger.warn(`MySQL sync-writer pooled connection error: ${err.message}`);
      });
    });

    this.pgPool = new PgPool({
      host: this.config.getOrThrow<string>('PG_HOST'),
      port: this.config.get<number>('PG_PORT', 5432),
      user: this.config.getOrThrow<string>('PG_USER'),
      password: this.config.getOrThrow<string>('PG_PASSWORD'),
      database: this.config.getOrThrow<string>('PG_DATABASE'),
      max: 3,
    });
    this.pgPool.on('error', (err) => {
      this.logger.warn(`Postgres pooled client error (push): ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.mysqlPool?.end();
    await this.pgPool?.end();
  }

  async pushAll(): Promise<PushResult[]> {
    return [await this.pushMeetingActions(), await this.pushMemberActions()];
  }

  async pushMeetingActions(): Promise<PushResult> {
    return this.processStagingTable(
      'exhibitor_app_meeting_action',
      (row) => this.applyMeetingAction(row),
    );
  }

  async pushMemberActions(): Promise<PushResult> {
    return this.processStagingTable(
      'exhibitor_app_member_action',
      (row) => this.applyMemberAction(row),
    );
  }

  /**
   * Loop generik: ambil baris pushed_at IS NULL dari satu tabel staging,
   * proses satu-satu (row gagal TIDAK menghentikan yang lain - dicatat
   * sebagai rowsFailed, tetap pushed_at NULL supaya dicoba lagi tick
   * berikutnya), tandai pushed_at begitu sukses.
   */
  private async processStagingTable(
    table: string,
    applyFn: (row: any) => Promise<void>,
  ): Promise<PushResult> {
    const startedAt = Date.now();
    let processed = 0;
    let failed = 0;
    const pgClient = await this.pgPool.connect();

    try {
      const { rows } = await pgClient.query(
        `SELECT * FROM "${table}" WHERE "pushed_at" IS NULL ORDER BY "created_at" ASC LIMIT $1`,
        [this.batchSize],
      );

      for (const row of rows) {
        try {
          await applyFn(row);
          await pgClient.query(`UPDATE "${table}" SET "pushed_at" = now() WHERE "id" = $1`, [
            row.id,
          ]);
          processed++;
        } catch (err: any) {
          failed++;
          this.logger.error(
            `Push failed for ${table} id=${row.id}: ${err.message}`,
            err.stack,
          );
        }
      }
    } finally {
      pgClient.release();
    }

    return {
      table,
      rowsProcessed: processed,
      rowsFailed: failed,
      durationMs: Date.now() - startedAt,
    };
  }

  private async applyMeetingAction(row: any): Promise<void> {
    if (row.action !== 'APPROVE' && row.action !== 'REJECT') {
      throw new Error(`Unknown meeting action: ${row.action}`);
    }
    const approvalStatus = row.action === 'APPROVE' ? 'AP' : 'CL';
    const status = row.action === 'APPROVE' ? 'OPEN' : 'CANCEL';

    // meeting_score (Hot/Warm/Cold) cuma di-set saat APPROVE - reject
    // tidak punya konsep temperature. COALESCE(?, meeting_score) supaya
    // kalau row.score kosong (reject), nilai lama tidak ke-null-kan.
    await this.mysqlQuery(
      `UPDATE events_meeting_v2
       SET approval_status = ?, \`Status\` = ?, meeting_score = COALESCE(?, meeting_score), last_update = NOW()
       WHERE events_id = ? AND id = ?`,
      [approvalStatus, status, row.score, row.events_id, row.meeting_id],
    );
  }

  private async applyMemberAction(row: any): Promise<void> {
    const { events_id, exhibitor_id, action, can_scan, can_chat, actor_exhibitor_id } = row;

    switch (action) {
      case 'INVITE':
        await this.mysqlQuery(
          `INSERT INTO exhibitor_member_status_sync
             (events_id, exhibitor_id, member_status, can_scan, can_chat, is_owner, invited_by, invited_at, last_update)
           VALUES (?, ?, 'INVITED', ?, ?, 'N', ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             member_status = 'INVITED',
             can_scan = VALUES(can_scan),
             can_chat = VALUES(can_chat),
             invited_by = VALUES(invited_by),
             invited_at = NOW(),
             last_update = NOW()`,
          [events_id, exhibitor_id, can_scan ?? 'Y', can_chat ?? 'Y', actor_exhibitor_id],
        );
        break;

      case 'ACTIVATE':
        await this.mysqlQuery(
          `INSERT INTO exhibitor_member_status_sync
             (events_id, exhibitor_id, member_status, can_scan, can_chat, activated_at, last_update)
           VALUES (?, ?, 'ACTIVE', ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             member_status = 'ACTIVE',
             can_scan = COALESCE(VALUES(can_scan), can_scan),
             can_chat = COALESCE(VALUES(can_chat), can_chat),
             activated_at = NOW(),
             last_update = NOW()`,
          [events_id, exhibitor_id, can_scan, can_chat],
        );
        break;

      case 'REMOVE':
        await this.mysqlQuery(
          `UPDATE exhibitor_member_status_sync
           SET member_status = 'REMOVED', removed_at = NOW(), last_update = NOW()
           WHERE events_id = ? AND exhibitor_id = ?`,
          [events_id, exhibitor_id],
        );
        break;

      case 'RESTORE':
        await this.mysqlQuery(
          `UPDATE exhibitor_member_status_sync
           SET member_status = 'ACTIVE', removed_at = NULL, last_update = NOW()
           WHERE events_id = ? AND exhibitor_id = ?`,
          [events_id, exhibitor_id],
        );
        break;

      case 'UPDATE_PERMISSION':
        // Murni ubah can_scan/can_chat - TIDAK menyentuh member_status atau
        // activated_at, beda dari ACTIVATE yang juga mengubah status.
        await this.mysqlQuery(
          `UPDATE exhibitor_member_status_sync
           SET can_scan = COALESCE(?, can_scan), can_chat = COALESCE(?, can_chat), last_update = NOW()
           WHERE events_id = ? AND exhibitor_id = ?`,
          [can_scan, can_chat, events_id, exhibitor_id],
        );
        break;

      default:
        throw new Error(`Unknown member action: ${action}`);
    }
  }

  /**
   * Sama seperti SyncService.mysqlQuery - retry sekali kalau connection
   * dari pool ternyata sudah basi (server MySQL disconnect karena idle).
   */
  private async mysqlQuery(sql: string, params: any[], retriesLeft = 1): Promise<any> {
    try {
      const [result] = await this.mysqlPool.query(sql, params);
      return result;
    } catch (err: any) {
      const isStaleConnection =
        err.code === 'PROTOCOL_CONNECTION_LOST' ||
        err.code === 'ECONNRESET' ||
        err.fatal === true ||
        /disconnected by the server because of inactivity/i.test(err.message ?? '');

      if (isStaleConnection && retriesLeft > 0) {
        this.logger.warn('Stale MySQL connection (push), retrying with fresh connection...');
        return this.mysqlQuery(sql, params, retriesLeft - 1);
      }
      throw err;
    }
  }
}
