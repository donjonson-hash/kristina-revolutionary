"""Legacy compatibility entry point.

Kristina's identity now lives in ``kristina_identity.py``.  This script is
kept only so old operational notes do not fail with FileNotFoundError; it no
longer rewrites ``ai_client.py``.
"""

from kristina_identity import build_system_prompt


if __name__ == "__main__":
    prompt = build_system_prompt()
    print("✅ Canonical Kristina identity is configured.")
    print("Role: Senior Software Engineer / Team Lead")
    print(f"Prompt length: {len(prompt)} chars")
