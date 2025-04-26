import { Module } from "@nestjs/common";
import { RecommendationsResolver } from "./recommendations.resolver";

@Module({
  providers: [RecommendationsResolver]
})
export class RecommendationsModule {}
