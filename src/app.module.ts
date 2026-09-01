import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SyncModule } from './sync/sync.module';
import { PushModule } from './push/push.module';

@Module({
  imports: [SyncModule, PushModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
