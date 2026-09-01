import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import * as Joi from 'joi';
import { SyncService } from './sync.service';
import { SyncScheduler } from './sync.scheduler';
import { SyncController } from './sync.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  imports: [
    // If ConfigModule.forRoot() is already called globally in AppModule,
    // remove this import here and just make sure the validation schema
    // below (or an equivalent) is merged into that global config setup.
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        MYSQL_HOST: Joi.string().required(),
        MYSQL_PORT: Joi.number().default(3306),
        MYSQL_USER: Joi.string().required(),
        MYSQL_PASSWORD: Joi.string().required(),
        MYSQL_DATABASE: Joi.string().required(),
        PG_HOST: Joi.string().required(),
        PG_PORT: Joi.number().default(5432),
        PG_USER: Joi.string().required(),
        PG_PASSWORD: Joi.string().required(),
        PG_DATABASE: Joi.string().required(),
        SYNC_BATCH_SIZE: Joi.number().default(500),
        SYNC_CRON_MINUTES: Joi.number().integer().min(1).max(59).default(5),
        SYNC_API_KEY: Joi.string().min(16).required(),
      }),
    }),
    ScheduleModule.forRoot(),
  ],
  providers: [SyncService, SyncScheduler, ApiKeyGuard],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
