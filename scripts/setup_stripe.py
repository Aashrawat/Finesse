
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"
WEBHOOK_URL = "https://aashrawat123-finesse.hf.space/api/billing/webhook"
APP_URL = "https://aashrawat123-finesse.hf.space"
EVENTS = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
]


def _env() -> dict[str, str]:
    return {k: (v or "").strip() for k, v in dotenv_values(ENV).items()}


def _set(name: str, value: str) -> None:
    text = ENV.read_text(encoding="utf-8") if ENV.exists() else ""
    lines = text.splitlines()
    prefix = f"{name}="
    for i, line in enumerate(lines):
        if line.startswith(prefix) or line.startswith(f"{name} ="):
            lines[i] = f"{name}={value}"
            ENV.write_text("\n".join(lines) + ("\n" if text.endswith("\n") else ""), encoding="utf-8")
            return
    ENV.write_text(text.rstrip("\n") + f"\n{name}={value}\n", encoding="utf-8")


def main() -> None:
    values = _env()
    key = values.get("STRIPE_SECRET_KEY", "")
    if not key:
        raise SystemExit("STRIPE_SECRET_KEY is missing from .env")

    import stripe

    stripe.api_key = key
    created: list[str] = []

    for plan, name, amount in (("pro", "Finesse Pro", 1299),):
        env_name = f"STRIPE_PRICE_{plan.upper()}"
        if values.get(env_name):
            print(f"{env_name} already set")
            continue
        product = stripe.Product.create(name=name, metadata={"plan": plan})
        price = stripe.Price.create(
            product=product.id,
            unit_amount=amount,
            currency="cad",
            recurring={"interval": "month"},
            metadata={"plan": plan},
        )
        _set(env_name, price.id)
        created.append(env_name)
        print(f"created {plan} price {price.id}")

    if not values.get("APP_URL"):
        _set("APP_URL", APP_URL)
        created.append("APP_URL")
        print("set APP_URL to the live Space")

    if values.get("STRIPE_WEBHOOK_SECRET"):
        print("STRIPE_WEBHOOK_SECRET already set")
    else:
        existing = [e for e in stripe.WebhookEndpoint.list(limit=20).auto_paging_iter() if e.url == WEBHOOK_URL]
        if existing:
            print("webhook endpoint already exists; add its signing secret in Stripe (Developers -> Webhooks)")
        else:
            endpoint = stripe.WebhookEndpoint.create(url=WEBHOOK_URL, enabled_events=EVENTS, description="Finesse Space")
            secret = getattr(endpoint, "secret", None)
            if secret:
                _set("STRIPE_WEBHOOK_SECRET", secret)
                created.append("STRIPE_WEBHOOK_SECRET")
                print("created webhook and saved STRIPE_WEBHOOK_SECRET")
            else:
                print("created webhook; copy its signing secret from Stripe (Developers -> Webhooks)")

    print("updated=" + (",".join(created) if created else "nothing"))


if __name__ == "__main__":
    main()
