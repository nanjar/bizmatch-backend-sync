import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool as PgPool } from 'pg';
import * as mysql from 'mysql2/promise';
import {
  ColumnDef,
  TABLE_SYNC_CONFIGS,
  TableSyncConfig,
} from './sync-tables.config';

interface NormalizedColumn {
  mysqlCol: string;
  pgCol: string;
  pgIdent: string;
}

export interface SyncResult {
  table: string;
  rowsSynced: number;
  rowsDeleted: number;
  durationMs: number;
}

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private mysqlPool: mysql.Pool;
  private pgPool: PgPool;
  private batchSize: number;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.batchSize = this.config.get<number>('SYNC_BATCH_SIZE', 500);

    this.mysqlPool = mysql.createPool({
      host: this.config.getOrThrow<string>('MYSQL_HOST'),
      port: this.config.get<number>('MYSQL_PORT', 3306),
      user: this.config.getOrThrow<string>('MYSQL_USER'),
      password: this.config.getOrThrow<string>('MYSQL_PASSWORD'),
      database: this.config.getOrThrow<string>('MYSQL_DATABASE'),
      connectionLimit: 5,
      // Proactively evict connections that have been idle too long,
      // BEFORE the MySQL server itself kills them (wait_timeout). This
      // matters here because the sync cron only runs every 5-10 minutes,
      // so pooled connections sit idle in between and are prime targets
      // for the server to disconnect first.
      idleTimeout: 60000, // 60s
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    // Without this listener, a background connection error (e.g. the
    // server closing an idle socket) is an unhandled 'error' event and
    // will crash the whole Node process. Log it instead — the retry
    // wrapper below handles getting a working connection on the next try.
    this.mysqlPool.on('connection', (conn) => {
      conn.on('error', (err) => {
        this.logger.warn(`MySQL pooled connection error: ${err.message}`);
      });
    });

    this.pgPool = new PgPool({
      host: this.config.getOrThrow<string>('PG_HOST'),
      port: this.config.get<number>('PG_PORT', 5432),
      user: this.config.getOrThrow<string>('PG_USER'),
      password: this.config.getOrThrow<string>('PG_PASSWORD'),
      database: this.config.getOrThrow<string>('PG_DATABASE'),
      max: 5,
    });

    // Same reasoning as above — pg's Pool emits 'error' for idle clients
    // that die in the background; must be handled or it crashes the app.
    this.pgPool.on('error', (err) => {
      this.logger.warn(`Postgres pooled client error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.mysqlPool?.end();
    await this.pgPool?.end();
  }

  /**
   * Runs a MySQL query via the pool, retrying once with a fresh
   * connection if the one handed out turned out to be stale (closed by
   * the server due to inactivity while sitting idle in the pool between
   * cron runs).
   */
  private async mysqlQuery(
    sql: string,
    params: any[],
    retriesLeft = 2,
  ): Promise<Record<string, any>[]> {
    try {
      const [rows] = await this.mysqlPool.query(sql, params);
      return rows as Record<string, any>[];
    } catch (err: any) {
      const isStaleConnection =
        err.code === 'PROTOCOL_CONNECTION_LOST' ||
        err.code === 'ECONNRESET' ||
        err.fatal === true ||
        /disconnected by the server because of inactivity/i.test(
          err.message ?? '',
        );

      if (isStaleConnection && retriesLeft > 0) {
        this.logger.warn(
          `Stale MySQL connection detected, retrying with a fresh one (${retriesLeft} attempt(s) left)...`,
        );
        return this.mysqlQuery(sql, params, retriesLeft - 1);
      }
      throw err;
    }
  }

  private normalizeColumn(col: ColumnDef): NormalizedColumn {
    if (typeof col === 'string') {
      return { mysqlCol: col, pgCol: col, pgIdent: col };
    }
    return {
      mysqlCol: col.mysql,
      pgCol: col.pg,
      pgIdent: col.quotePg ? `"${col.pg}"` : col.pg,
    };
  }

  /** Sync every configured table. Returns a per-table result summary. */
  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const config of TABLE_SYNC_CONFIGS) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.syncTable(config));
    }
    return results;
  }

  /** Sync a single table by its MySQL source table name. */
  async syncOne(mysqlTable: string): Promise<SyncResult> {
    const config = TABLE_SYNC_CONFIGS.find((t) => t.mysqlTable === mysqlTable);
    if (!config) {
      throw new Error(`No sync config found for table "${mysqlTable}"`);
    }
    return this.syncTable(config);
  }

  private async syncTable(config: TableSyncConfig): Promise<SyncResult> {
    const startedAt = Date.now();
    const columns = config.columns.map((c) => this.normalizeColumn(c));
    const mysqlColList = columns.map((c) => `\`${c.mysqlCol}\``).join(', ');
    const pgColList = columns.map((c) => c.pgIdent).join(', ');
    const conflictList = config.conflictKeys.join(', ');

    const updateCols = columns.filter(
      (c) => !config.conflictKeys.includes(c.pgCol),
    );
    const updateClause = updateCols
      .map((c) => `${c.pgIdent} = EXCLUDED.${c.pgIdent}`)
      .concat(['synced_at = now()'])
      .join(',\n      ');

    const pgClient = await this.pgPool.connect();
    let offset = 0;
    let totalSynced = 0;
    let totalDeleted = 0;
    const transform = config.transform ?? ((row: any) => row);

    try {
      // Cutoff for the delete-sweep below. Taken from Postgres's own
      // clock (not the app server's) to avoid clock-skew issues — any
      // row whose synced_at ends up older than this cutoff after the
      // upsert loop was NOT touched this run, meaning it no longer
      // exists in MySQL and should be removed.
      const { rows: nowRows } = await pgClient.query<{ ts: Date }>(
        'SELECT now() AS ts',
      );
      const cutoff = nowRows[0].ts;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const selectSql =
          config.customQuery ??
          `SELECT ${mysqlColList} FROM \`${config.mysqlTable}\` LIMIT ? OFFSET ?`;

        // eslint-disable-next-line no-await-in-loop
        const rowArray = await this.mysqlQuery(selectSql, [
          this.batchSize,
          offset,
        ]);
        if (rowArray.length === 0) break;

        const transformed = rowArray.map((r) => transform(r));

        const placeholders: string[] = [];
        const values: any[] = [];
        transformed.forEach((row, rowIdx) => {
          const rowPlaceholders = columns.map((_c, colIdx) => {
            const paramIndex = rowIdx * columns.length + colIdx + 1;
            return `$${paramIndex}`;
          });
          placeholders.push(`(${rowPlaceholders.join(', ')})`);
          columns.forEach((c) => values.push(row[c.mysqlCol]));
        });

        const sql = `
          INSERT INTO ${config.pgTable} (${pgColList})
          VALUES ${placeholders.join(',\n                 ')}
          ON CONFLICT (${conflictList}) DO UPDATE SET
          ${updateClause}
        `;

        // eslint-disable-next-line no-await-in-loop
        await pgClient.query(sql, values);

        totalSynced += rowArray.length;
        offset += this.batchSize;
      }

      // Delete-sweep: remove rows that weren't touched by this run,
      // i.e. rows that used to exist but are gone from MySQL now.
      // Skippable per-table via `syncDeletes: false` in the config, for
      // tables where you'd rather keep history than mirror deletes.
      if (config.syncDeletes !== false) {
        const deleteResult = await pgClient.query(
          `DELETE FROM ${config.pgTable} WHERE synced_at < $1`,
          [cutoff],
        );
        totalDeleted = deleteResult.rowCount ?? 0;
        if (totalDeleted > 0) {
          this.logger.log(
            `${config.pgTable}: removed ${totalDeleted} row(s) no longer present in MySQL`,
          );
        }
      }

      this.logger.log(
        `${config.mysqlTable} -> ${config.pgTable}: synced ${totalSynced} rows, deleted ${totalDeleted} stale row(s)`,
      );
    } catch (err) {
      this.logger.error(
        `Sync failed for ${config.mysqlTable} -> ${config.pgTable}: ${err.message}`,
        err.stack,
      );
      throw err;
    } finally {
      pgClient.release();
    }

    return {
      table: config.mysqlTable,
      rowsSynced: totalSynced,
      rowsDeleted: totalDeleted,
      durationMs: Date.now() - startedAt,
    };
  }
}
