import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

export interface ProviderIdentity {
  subject: string;
  providerId?: string;
  authenticated: boolean;
}

export interface ProviderIdentityPort {
  resolveFromRequest(headers: Record<string, string | string[] | undefined>): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async resolveFromRequest(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<ProviderIdentity> {
    const providerHeader = headers["x-provider-id"];
    return {
      subject: "anonymous-local",
      providerId: Array.isArray(providerHeader) ? providerHeader[0] : providerHeader,
      authenticated: false,
    };
  }
}

/**
 * Extension point for external IdP (Keycloak/Zitadel OIDC) token validation.
 * Health endpoints and internal SQS messages bypass HTTP authentication by design.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  async canActivate(_context: ExecutionContext): Promise<boolean> {
    return true;
  }
}
