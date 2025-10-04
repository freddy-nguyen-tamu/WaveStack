import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AuthPayload, AuthUser } from "./auth.models";
import { AuthService } from "./auth.service";

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => AuthPayload)
  async register(
    @Args("email") email: string,
    @Args("displayName") displayName: string,
    @Args("password") password: string
  ): Promise<AuthPayload> {
    return this.authService.register(email, displayName, password);
  }

  @Mutation(() => AuthPayload)
  async login(
    @Args("email") email: string,
    @Args("password") password: string
  ): Promise<AuthPayload> {
    return this.authService.login(email, password);
  }

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
