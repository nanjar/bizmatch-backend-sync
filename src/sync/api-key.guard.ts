import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Simple shared-secret guard for internal/admin endpoints.
 * Checks the `x-api-key` header against SYNC_API_KEY from .env.
 *
 * This is intentionally lightweight — good enough to keep the sync
 * endpoint from being publicly callable while the project has no
 * full auth system yet. Swap this out for a proper JWT/RolesGuard
 * once real user auth exists.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.headers['x-api-key'];
    const expectedKey = this.config.get<string>('SYNC_API_KEY');

    if (!expectedKey) {
      // Fail closed: if the key isn't configured, nobody gets in.
      // (Prevents accidentally leaving this open because .env was
      // never filled in.)
      throw new UnauthorizedException('SYNC_API_KEY is not configured');
    }

    if (!providedKey || providedKey !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing API key');
    }

    return true;
  }
}
