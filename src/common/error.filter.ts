import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import type { Response } from "express";
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const e = error as { code?: string; message?: string };
    let status = 500;
    let body: unknown = { message: "Unexpected server error" };
    if (error instanceof HttpException) {
      status = error.getStatus();
      body = error.getResponse();
    } else if (["23505", "23P01", "23503", "23514"].includes(e.code || "")) {
      status = 409;
      body = {
        message:
          e.code === "23505"
            ? "A record with these details already exists."
            : e.code === "23P01"
              ? "Dates conflict with an existing tenancy or meter installation."
              : "This change conflicts with linked records or financial rules.",
      };
    } else if (["40001", "40P01", "55P03"].includes(e.code || "")) {
      status = 409;
      body = { message: "Concurrent change detected. Retry the operation." };
    }
    if (status === 500)
      console.error("Request failed", e.code || "", e.message);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(status).json({
      error: typeof body === "string" ? { message: body } : body,
      requestId: res.getHeader("X-Request-Id"),
    });
  }
}
