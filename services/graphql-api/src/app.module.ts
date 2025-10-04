import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { UsersModule } from "./users/users.module";
import { MusicModule } from "./music/music.module";
import { PlaylistsModule } from "./playlists/playlists.module";
import { SearchModule } from "./search/search.module";
import { HistoryModule } from "./history/history.module";
import { RecommendationsModule } from "./recommendations/recommendations.module";
import { StorageModule } from "./storage/storage.module";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { HabitsModule } from "./habits/habits.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      playground: true,
      sortSchema: true,
      context: ({ req }: { req: Record<string, unknown> }) => ({ req })
    }),
    DatabaseModule,
    UsersModule,
    MusicModule,
    PlaylistsModule,
    SearchModule,
    HistoryModule,
    RecommendationsModule,
    StorageModule,
    AuthModule,
    HabitsModule
  ]
})
export class AppModule {}
