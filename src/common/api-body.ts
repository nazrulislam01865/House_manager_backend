import { ApiBody } from "@nestjs/swagger";
import { z } from "zod";
export function BodyDoc(schema: z.ZodType) {
  return ApiBody({
    schema: z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as never,
  });
}
