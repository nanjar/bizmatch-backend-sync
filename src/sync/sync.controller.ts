import { Controller, Post, Param, UseGuards, Logger } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { SyncService } from './sync.service';

@Controller('admin/sync')
@UseGuards(ApiKeyGuard)
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(private readonly syncService: SyncService) {}

  @Post('run')
  async runAll() {
    this.logger.log('Manual full sync triggered');
    const results = await this.syncService.syncAll();
    return {
      ok: true,
      totalRows: results.reduce((sum, r) => sum + r.rowsSynced, 0),
      totalDeleted: results.reduce((sum, r) => sum + r.rowsDeleted, 0),
      tables: results,
    };
  }

  @Post('run/:table')
  async runOne(@Param('table') table: string) {
    this.logger.log(`Manual sync triggered for table: ${table}`);
    const result = await this.syncService.syncOne(table);
    return { ok: true, ...result };
  }
}
