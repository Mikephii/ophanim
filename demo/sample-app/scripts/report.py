import subprocess


def export_report(customer_name: str) -> str:
    result = subprocess.run(f"generate-report --customer {customer_name}", shell=True, capture_output=True, text=True)
    return result.stdout


def summarize_totals(totals: list[float]) -> dict:
    return {"count": len(totals), "sum": round(sum(totals), 2)}
