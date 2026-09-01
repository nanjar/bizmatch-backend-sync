import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SyncService } from './sync.service';

@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private isRunning = false;

  constructor(
    private readonly syncService: SyncService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit() {
    // Interval is configurable via SYNC_CRON_MINUTES (default 5).
    // Set it to 10 (or anything else) in .env without touching code.
    const minutes = this.config.get<number>('SYNC_CRON_MINUTES', 5);
    const cronExpression = `0 */${minutes} * * * *`; // every N minutes, on the minute

    const job = new CronJob(cronExpression, () => this.runSync());
    this.schedulerRegistry.addCronJob('mysql-to-postgres-sync', job);
    job.start();

    this.logger.log(
      `Sync scheduler registered: running every ${minutes} minute(s) (cron: "${cronExpression}")`,
    );
  }

  private async runSync() {
    if (this.isRunning) {
      this.logger.warn('Previous sync still running, skipping this tick.');
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();
    this.logger.log('Starting scheduled sync...');

    try {
      const results = await this.syncService.syncAll();
      const totalRows = results.reduce((sum, r) => sum + r.rowsSynced, 0);
      const totalDeleted = results.reduce((sum, r) => sum + r.rowsDeleted, 0);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.logger.log(
        `Scheduled sync complete: ${totalRows} rows synced, ${totalDeleted} stale rows deleted, across ${results.length} tables in ${seconds}s`,
      );
    } catch (err) {
      this.logger.error('Scheduled sync failed', err.stack);
    } finally {
      this.isRunning = false;
    }
  }
}

