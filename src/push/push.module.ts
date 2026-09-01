import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PushScheduler } from './push.scheduler';
import { PushController } from './push.controller';
import { SyncModule } from '../sync/sync.module';

/**
 * PushModule SENGAJA tidak memanggil ConfigModule.forRoot()/
 * ScheduleModule.forRoot() lagi - keduanya sudah didaftarkan sebagai
 * global module oleh SyncModule. Import SyncModule di sini supaya
 * ApiKeyGuard (dipakai ulang, bukan duplikat) dan urutan modul jelas.
 */
@Module({
  imports: [SyncModule],
  providers: [PushService, PushScheduler],
  controllers: [PushController],
  exports: [PushService],
})
export class PushModule {}
