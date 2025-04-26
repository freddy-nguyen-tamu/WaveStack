import { Module } from "@nestjs/common";
import { HistoryResolver } from "./history.resolver";

@Module({
  providers: [HistoryResolver]
})
export class HistoryModule {}
