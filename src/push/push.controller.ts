import { Controller, Post, UseGuards } from '@nestjs/common';
import { PushService } from './push.service';
import { ApiKeyGuard } from '../sync/api-key.guard';

@Controller('admin/push')
@UseGuards(ApiKeyGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Post('run')
  async runAll() {
    const results = await this.pushService.pushAll();
    return {
      ok: true,
      totalProcessed: results.reduce((sum, r) => sum + r.rowsProcessed, 0),
      totalFailed: results.reduce((sum, r) => sum + r.rowsFailed, 0),
      tables: results,
    };
  }
}
