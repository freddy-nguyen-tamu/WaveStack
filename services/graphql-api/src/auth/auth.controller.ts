import { Controller, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService
  ) {}

  @Get("google/url")
  getGoogleUrl() {
    return { url: this.authService.getGoogleAuthUrl() };
  }

  @Get("google/callback")
  async googleCallback(
    @Query("code") code: string | undefined,
    @Query("error") error: string | undefined,
    @Res() response: Response
  ) {
    const frontendOrigin =
      this.config.get<string>("FRONTEND_PUBLIC_ORIGIN") ??
      this.config.get<string>("FRONTEND_ORIGIN") ??
      "https://wavestack.duckdns.org";

    const profileUrl = new URL("/profile", frontendOrigin);

    if (error) {
      profileUrl.searchParams.set("authError", error);
      return response.redirect(profileUrl.toString());
    }

    if (!code) {
      profileUrl.searchParams.set("authError", "missing_code");
      return response.redirect(profileUrl.toString());
    }

    try {
      const result = await this.authService.handleGoogleCallback(code);

      profileUrl.searchParams.set("token", result.token);
      profileUrl.searchParams.set(
        "user",
        Buffer.from(JSON.stringify(result.user), "utf8").toString("base64url")
      );

      return response.redirect(profileUrl.toString());
    } catch (callbackError) {
      const message =
        callbackError instanceof Error ? callbackError.message : String(callbackError);

      profileUrl.searchParams.set("authError", message.slice(0, 160));
      return response.redirect(profileUrl.toString());
    }
  }
}
