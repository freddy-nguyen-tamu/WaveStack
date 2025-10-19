import { Context, Query, Resolver } from "@nestjs/graphql";
import { AuthUser } from "./auth.models";
import { AuthService } from "./auth.service";

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Query(() => AuthUser, { nullable: true })
  async me(@Context("req") req: RequestWithAuth): Promise<AuthUser | null> {
    const authHeader = req.headers?.authorization ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);

    try {
      const payload = this.authService.verifyToken(token);
      return this.authService.me(payload.userId);
    } catch {
      return null;
    }
  }
}

type RequestWithAuth = {
  headers?: {
    authorization?: string;
  };
};
