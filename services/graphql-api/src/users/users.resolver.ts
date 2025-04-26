import { Field, ID, ObjectType, Query, Resolver } from "@nestjs/graphql";

@ObjectType()
class UserProfile {
  @Field(() => ID)
  id!: string;

  @Field()
  displayName!: string;
}

@Resolver(() => UserProfile)
export class UsersResolver {
  @Query(() => UserProfile)
  me(): UserProfile {
    return { id: "user-1", displayName: "WaveStack Listener" };
  }
}
