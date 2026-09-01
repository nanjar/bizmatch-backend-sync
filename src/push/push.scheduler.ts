import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PushService } from './push.service';

@Injectable()
export class PushScheduler implements OnModuleInit {
  private readonly logger = new Logger(PushScheduler.name);
  private isRunning = false;

  constructor(
    private readonly pushService: PushService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit() {
    // Lebih sering dari pull-sync (default 5 menit) karena approve/reject
    // meeting & perubahan member butuh terasa responsif buat exhibitor.
    // Configurable via PUSH_CRON_MINUTES, default 1 menit.
    const minutes = this.config.get<number>('PUSH_CRON_MINUTES', 1);
    const cronExpression = minutes <= 1 ? '0 * * * * *' : `0 */${minutes} * * * *`;

    const job = new CronJob(cronExpression, () => this.runPush());
    this.schedulerRegistry.addCronJob('postgres-to-mysql-push', job);
    job.start();

    this.logger.log(
      `Push scheduler registered: running every ${minutes} minute(s) (cron: "${cronExpression}")`,
    );
  }

  private async runPush() {
    if (this.isRunning) {
      this.logger.warn('Previous push still running, skipping this tick.');
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();

    try {
      const results = await this.pushService.pushAll();
      const totalProcessed = results.reduce((sum, r) => sum + r.rowsProcessed, 0);
      const totalFailed = results.reduce((sum, r) => sum + r.rowsFailed, 0);

      // Sengaja TIDAK log kalau tidak ada apa-apa yang diproses - push
      // jalan tiap 1 menit, kalau selalu log bakal bikin noise log besar
      // untuk kondisi normal (tidak ada aksi baru dari exhibitor app).
      if (totalProcessed > 0 || totalFailed > 0) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        this.logger.log(
          `Scheduled push complete: ${totalProcessed} row(s) pushed, ${totalFailed} failed, in ${seconds}s`,
        );
      }
    } catch (err) {
      this.logger.error('Scheduled push failed', err.stack);
    } finally {
      this.isRunning = false;
    }
  }
}
