import { Controller, Get, HttpException, HttpStatus, Query, Res } from "@nestjs/common";
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
    if (!code) {
      throw new HttpException("Missing authorization code", HttpStatus.BAD_REQUEST);
    }

    try {
      const { token } = await this.authService.authenticateWithGoogleCode(code);
      const frontendOrigin = this.config.get<string>("FRONTEND_ORIGIN") ?? "https://app.wavestack.duckdns.org";
      res.redirect(`${frontendOrigin}/oauth-callback#token=${token}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth authentication failed";
      const frontendOrigin = this.config.get<string>("FRONTEND_ORIGIN") ?? "https://app.wavestack.duckdns.org";
      res.redirect(`${frontendOrigin}/oauth-callback#error=${encodeURIComponent(message)}`);
    }
  }
}
