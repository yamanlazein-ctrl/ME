import type { Request, Response, NextFunction } from "express";
import { logger } from "../../config/logger.js";
import { looksTechnical } from "../../errors/persistenceErrorMessage.js";

/**
 * Last line of defence for error text: no response may show SQL, a query, table
 * or column names, parameters or a stack to the user. Many routes forward a
 * use-case's `error` string verbatim; when that string is technical it is
 * replaced here by a plain Arabic message (by kind of failure) and the original
 * goes to the log. Well-formed business messages pass through untouched.
 */
const FRIENDLY: Record<string, { code: string; message: string }> = {
  conflict: {
    code: "SYNC_CONFLICT",
    message: "تغيّرت هذه البيانات على جهاز آخر أو في نافذة أخرى — حدّث الصفحة ثم أعد المحاولة.",
  },
  unavailable: {
    code: "SERVER_UNAVAILABLE",
    message: "الخدمة غير متاحة الآن — أعد المحاولة بعد قليل.",
  },
  database: {
    code: "DATABASE_ERROR",
    message: "تعذّر حفظ التغييرات بسبب مشكلة في البيانات — أعد المحاولة، وإذا تكرر الأمر راجع مسؤول النظام.",
  },
};

export function userFacingErrors(req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    const msg = (body as { message?: unknown } | null)?.message;
    if (res.statusCode >= 400 && typeof msg === "string" && looksTechnical(msg)) {
      const kind = res.statusCode === 409 ? "conflict" : res.statusCode >= 502 ? "unavailable" : "database";
      logger.error(
        { path: req.path, method: req.method, status: res.statusCode, technical: msg.slice(0, 4000) },
        "technical error text withheld from the user",
      );
      return json({ ...(body as object), ...FRIENDLY[kind] });
    }
    return json(body);
  }) as Response["json"];
  next();
}
