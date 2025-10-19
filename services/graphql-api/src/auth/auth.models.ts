import { Field, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class AuthUser {
  @Field()
  id!: string;

  @Field()
  email!: string;

  @Field()
  displayName!: string;

  @Field({ nullable: true })
  avatarUrl?: string;
}

@ObjectType()
export class AuthPayload {
  @Field()
  token!: string;

  @Field(() => AuthUser)
  user!: AuthUser;
}
