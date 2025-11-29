import { Controller, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService
  ) {}

  @Get("google/url")
  getGoogleAuthUrl(): { url: string } {
    return { url: this.authService.getGoogleAuthUrl() };
  }

  @Get("google/callback")
  async googleCallback(@Query("code") code: string, @Res() res: Response): Promise<void> {
    const frontendOrigin =
      this.config.get<string>("FRONTEND_ORIGIN") ?? "https://wavestack.duckdns.org";

    if (!code) {
      const url = new URL("/oauth-callback", frontendOrigin);
      url.searchParams.set("error", "Missing authorization code");
      res.redirect(url.toString());
      return;
    }

    try {
      const { token } = await this.authService.authenticateWithGoogleCode(code);
      const url = new URL("/oauth-callback", frontendOrigin);
      url.searchParams.set("token", token);
      res.redirect(url.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth authentication failed";
      const url = new URL("/oauth-callback", frontendOrigin);
      url.searchParams.set("error", message);
      res.redirect(url.toString());
    }
  }
}
