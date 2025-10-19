import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthResolver } from "./auth.resolver";
import { AuthController } from "./auth.controller";

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthResolver],
  exports: [AuthService]
})
export class AuthModule {}
