import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SignedUrlService } from "./signed-url.service";

@Module({
  imports: [ConfigModule],
  providers: [SignedUrlService],
  exports: [SignedUrlService]
})
export class StorageModule {}
