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
    return [
      await this.pushMeetingActions(),
      await this.pushMemberActions(),
      await this.pushLeadActions(),
      await this.pushLinkClicks(),
    ];
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

  async pushLeadActions(): Promise<PushResult> {
    return this.processStagingTable(
      'exhibitor_app_lead_action',
      (row) => this.applyLeadAction(row),
    );
  }

  /**
   * REDESIGN (Sept 2026): ternyata MySQL sudah punya 6 tabel legacy
   * terpisah per tipe link (instagram_clicked_v2, facebook_clicked,
   * tiktok_clicked, twitter_clicked, promo_clicked_v2,
   * producturl_clicked_v2) - BUKAN satu tabel gabungan kayak
   * link_click_log_sync yang saya buat sebelumnya (SALAH, sudah dihapus
   * dari rencana). Skemanya pakai pola COUNTER (times_clicked bertambah),
   * bukan log per-kejadian - PK (events_id, company_id, product_id,
   * guests_id, member_guests_id).
   *
   * WEBSITE & BROCHURE TIDAK punya tabel legacy (cuma 6 tipe di atas) -
   * baris dengan link_type itu di-skip dari push (tetap tercatat di
   * Postgres buat Reports internal exhibitor app, gak pernah nyampe ke
   * MySQL sampai ada tabel yang jelas nanti).
   *
   * product_id NULL (company belum punya product sama sekali) juga
   * di-skip - tabel legacy product_id NOT NULL, gak ada nilai valid buat
   * dikirim.
   */
  private readonly LINK_TYPE_TABLE_MAP: Record<string, string> = {
    INSTAGRAM: 'instagram_clicked_v2',
    FACEBOOK: 'facebook_clicked',
    TIKTOK: 'tiktok_clicked',
    TWITTER: 'twitter_clicked',
    PROMO: 'promo_clicked_v2',
    PRODUCT_URL: 'producturl_clicked_v2',
  };

  async pushLinkClicks(): Promise<PushResult> {
    const startedAt = Date.now();
    let processed = 0;
    let failed = 0;
    const pgClient = await this.pgPool.connect();

    try {
      const { rows } = await pgClient.query(
        `SELECT * FROM "link_click_log" WHERE "pushed_at" IS NULL ORDER BY "clicked_at" ASC LIMIT $1`,
        [this.batchSize],
      );

      for (const row of rows) {
        try {
          const table = this.LINK_TYPE_TABLE_MAP[row.link_type];

          if (!table) {
            // WEBSITE/BROCHURE - gak ada tabel legacy, skip push tapi
            // tetap tandai pushed supaya gak dicoba ulang selamanya.
            this.logger.debug(
              `link_click_log id=${row.id}: linkType ${row.link_type} gak punya tabel legacy, skip push`,
            );
          } else if (row.product_id == null) {
            this.logger.warn(
              `link_click_log id=${row.id}: product_id NULL (company ${row.company_id} belum punya product), skip push`,
            );
          } else {
            await this.mysqlQuery(
              `INSERT INTO \`${table}\`
                 (events_id, company_id, product_id, guests_id, member_guests_id, times_clicked)
               VALUES (?, ?, ?, ?, ?, 1)
               ON DUPLICATE KEY UPDATE times_clicked = times_clicked + 1`,
              [
                row.events_id,
                row.company_id,
                row.product_id,
                row.guests_id,
                row.member_guests_id,
              ],
            );
          }

          await pgClient.query(
            `UPDATE "link_click_log" SET "pushed_at" = now() WHERE "id" = $1`,
            [row.id],
          );
          processed++;
        } catch (err: any) {
          failed++;
          this.logger.error(`Push failed for link_click_log id=${row.id}: ${err.message}`, err.stack);
        }
      }
    } finally {
      pgClient.release();
    }

    return {
      table: 'link_click_log',
      rowsProcessed: processed,
      rowsFailed: failed,
      durationMs: Date.now() - startedAt,
    };
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
    if (row.action === 'RESCHEDULE') {
      await this.mysqlQuery(
        `UPDATE events_meeting_v2
         SET start_datetime = ?, end_datetime = ?, last_update = NOW()
         WHERE events_id = ? AND id = ?`,
        [row.new_start_datetime, row.new_end_datetime, row.events_id, row.meeting_id],
      );
      return;
    }

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
   * Lead baru dari My Booth (scan/tambah manual). Selalu INSERT ke
   * exhibitor_lead_sync (source of truth utama). Kalau source SCAN/
   * EVENT_GUEST DAN ada guests_id valid, JUGA INSERT/UPDATE checkin_booth
   * (tabel legacy, PK butuh guests_id NOT NULL - makanya MANUAL tidak
   * pernah nyentuh tabel ini sama sekali).
   */
  private async applyLeadAction(row: any): Promise<void> {
    if (row.action === 'UPDATE_NOTES') {
      await this.mysqlQuery(
        `UPDATE exhibitor_lead_sync SET notes = ?, last_update = NOW() WHERE id = ?`,
        [row.notes, row.lead_id],
      );
      return;
    }

    // action === 'CREATE' (default, termasuk row lama sebelum kolom
    // action ditambahkan)
    const {
      events_id,
      company_id,
      venue_id,
      space_id,
      actor_exhibitor_id,
      guests_id,
      source,
      manual_fullname,
      manual_phone,
      manual_company,
      notes,
      created_at,
    } = row;

    await this.mysqlQuery(
      `INSERT INTO exhibitor_lead_sync
         (events_id, company_id, venue_id, space_id, exhibitor_id, guests_id,
          source, manual_fullname, manual_phone, manual_company, notes,
          created_at, last_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        events_id,
        company_id,
        venue_id,
        space_id,
        actor_exhibitor_id,
        guests_id,
        source,
        manual_fullname,
        manual_phone,
        manual_company,
        notes,
        created_at,
      ],
    );

    if ((source === 'SCAN' || source === 'EVENT_GUEST') && guests_id != null) {
      await this.mysqlQuery(
        `INSERT INTO checkin_booth
           (events_id, company_id, venue_id, space_id, scan_by, guests_id,
            checkin_datetime, member_id, visitor_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           checkin_datetime = VALUES(checkin_datetime),
           member_id = VALUES(member_id),
           visitor_notes = VALUES(visitor_notes),
           last_update = NOW()`,
        [
          events_id,
          company_id,
          venue_id,
          space_id,
          String(actor_exhibitor_id),
          guests_id,
          created_at,
          actor_exhibitor_id,
          notes,
        ],
      );
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
