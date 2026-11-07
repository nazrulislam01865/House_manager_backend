import {
  Injectable,
  Inject,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { Database } from "../database/database.service.js";
import { type Actor, audit, one, outbox } from "../common/context.js";
import { type ListQuery } from "../common/validation.js";
import { paginate } from "../common/pagination.js";
import { idempotent } from "../billing/idempotency.js";
export type PaymentInput = {
  amountMinor: string;
  method: string;
  receivedAt: string;
};
const paymentSelect = `SELECT p.id,p.bill_id AS "billId",p.receipt_number AS "receiptNumber",p.amount_minor::text AS "amountMinor",p.kind,p.method,p.received_at AS "receivedAt",p.recorded_at AS "recordedAt",p.reason,b.type,b.month,u.name AS "residentName",r.number AS "roomNumber",h.name AS "houseName",EXISTS(SELECT 1 FROM payments rv WHERE rv.reverses_id=p.id) AS reversed FROM payments p JOIN bills b ON b.id=p.bill_id JOIN users u ON u.id=b.resident_id JOIN rooms r ON r.id=b.room_id JOIN houses h ON h.id=b.house_id`;
@Injectable()
export class CollectionsService {
  constructor(@Inject(Database) private db: Database) {}
  async collect(
    a: Actor,
    type: "rent" | "electricity",
    billId: string,
    d: PaymentInput,
    key: string | undefined,
  ) {
    return this.db.tx((c) =>
      idempotent(c, a, type + ".payment:" + billId, key, d, async () => {
        const b = await one(
          c,
          "SELECT * FROM bills WHERE organization_id=$1 AND id=$2 AND type=$3 FOR UPDATE",
          [a.organizationId, billId, type],
        );
        if (b.lifecycle !== "ISSUED")
          throw new ConflictException("Bill is void");
        const amount = BigInt(d.amountMinor);
        if (
          amount <= 0n ||
          amount > BigInt(b.amount_minor) - BigInt(b.paid_minor)
        )
          throw new ConflictException(
            "Amount must be positive and within the remaining balance",
          );
        const day = (
          await c.query(
            "SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date AS today",
          )
        ).rows[0].today;
        if (d.receivedAt > String(day) || d.receivedAt < String(b.month))
          throw new BadRequestException(
            "Payment date must be between the bill month and today",
          );
        const p = await one(
          c,
          "INSERT INTO payments(organization_id,bill_id,kind,amount_minor,method,received_at,actor_id) VALUES($1,$2,'PAYMENT',$3,$4,$5,$6) RETURNING id,receipt_number AS \"receiptNumber\"",
          [
            a.organizationId,
            billId,
            d.amountMinor,
            d.method,
            d.receivedAt,
            a.id,
          ],
        );
        const balance = await one(
          c,
          'UPDATE bills SET paid_minor=paid_minor+$1,version=version+1 WHERE id=$2 RETURNING paid_minor::text AS "paidMinor",(amount_minor-paid_minor)::text AS "remainingMinor",version',
          [d.amountMinor, billId],
        );
        await audit(c, a, "payment.recorded", p.id, {
          type,
          billId,
          amountMinor: d.amountMinor,
        });
        await outbox(c, a, "payment.recorded", { paymentId: p.id, billId });
        return { ...p, ...balance };
      }),
    );
  }
  async reverse(
    a: Actor,
    paymentId: string,
    reason: string,
    key: string | undefined,
  ) {
    return this.db.tx((c) =>
      idempotent(
        c,
        a,
        "payment.reverse:" + paymentId,
        key,
        { reason },
        async () => {
          const p = await one(
            c,
            "SELECT * FROM payments WHERE id=$1 AND organization_id=$2 AND kind='PAYMENT'",
            [paymentId, a.organizationId],
          );
          await one(c, "SELECT id FROM bills WHERE id=$1 FOR UPDATE", [
            p.bill_id,
          ]);
          if (
            (
              await c.query("SELECT 1 FROM payments WHERE reverses_id=$1", [
                paymentId,
              ])
            ).rowCount
          )
            throw new ConflictException("Payment already reversed");
          const reversal = await one(
            c,
            "INSERT INTO payments(organization_id,bill_id,kind,amount_minor,method,received_at,actor_id,reverses_id,reason) VALUES($1,$2,'REVERSAL',$3,$4,(now() AT TIME ZONE 'Asia/Dhaka')::date,$5,$6,$7) RETURNING id",
            [
              a.organizationId,
              p.bill_id,
              p.amount_minor,
              p.method,
              a.id,
              paymentId,
              reason,
            ],
          );
          await c.query(
            "UPDATE bills SET paid_minor=paid_minor-$1,version=version+1 WHERE id=$2",
            [p.amount_minor, p.bill_id],
          );
          await audit(c, a, "payment.reversed", paymentId, {
            reason,
            reversalId: reversal.id,
          });
          await outbox(c, a, "payment.reversed", {
            paymentId,
            reversalId: reversal.id,
          });
          return reversal;
        },
      ),
    );
  }
  list(a: Actor, q: ListQuery, type?: string) {
    return paginate(
      this.db,
      paymentSelect +
        ` WHERE p.organization_id=$1 AND ($2::text IS NULL OR b.type=$2) AND ($3::uuid IS NULL OR b.house_id=$3) AND ($4::date IS NULL OR b.month=$4) ORDER BY p.recorded_at DESC,p.id DESC`,
      [
        a.organizationId,
        type || null,
        q.houseId || null,
        q.month ? q.month + "-01" : null,
      ],
      q,
    );
  }
  receipt(a: Actor, id: string) {
    return this.db.tx((c) =>
      one(c, paymentSelect + " WHERE p.organization_id=$1 AND p.id=$2", [
        a.organizationId,
        id,
      ]),
    );
  }
}
