"""Install mattpocock/skills into CheetahClaws .cheetahclaws/skills/ directory."""
import os
import shutil

SRC = r"D:\cc data agent\_mattpocock_skills_temp\skills"
DST = r"D:\cc data agent\.cheetahclaws\skills"

# Category-based triggers for each skill
SKILL_TRIGGERS = {
    "engineering": {
        "diagnose": ["/diagnose", "diagnose", "debug this", "fix bug"],
        "tdd": ["/tdd", "tdd", "red-green-refactor", "test driven"],
        "triage": ["/triage", "triage issues"],
        "grill-with-docs": ["/grill-with-docs", "grill with docs"],
        "improve-codebase-architecture": ["/improve-architecture", "improve architecture"],
        "prototype": ["/prototype", "prototype this"],
        "setup-matt-pocock-skills": ["/setup-skills"],
        "to-issues": ["/to-issues", "break into issues"],
        "to-prd": ["/to-prd", "create prd"],
        "zoom-out": ["/zoom-out", "zoom out", "big picture"],
    },
    "productivity": {
        "caveman": ["/caveman", "caveman mode", "talk like caveman"],
        "grill-me": ["/grill-me", "grill me", "grill my plan"],
        "handoff": ["/handoff", "handoff", "create handoff"],
        "write-a-skill": ["/write-a-skill", "create new skill"],
    },
    "personal": {
        "edit-article": ["/edit-article", "edit article"],
        "obsidian-vault": ["/obsidian-vault"],
    },
    "misc": {
        "git-guardrails-claude-code": ["/git-guardrails"],
        "migrate-to-shoehorn": ["/migrate-to-shoehorn"],
        "scaffold-exercises": ["/scaffold-exercises"],
        "setup-pre-commit": ["/setup-pre-commit"],
    },
    "in-progress": {
        "review": ["/review-mp"],
        "writing-beats": ["/writing-beats"],
        "writing-fragments": ["/writing-fragments"],
        "writing-shape": ["/writing-shape"],
    },
    "deprecated": {
        "design-an-interface": ["/design-interface"],
        "qa": ["/qa"],
        "request-refactor-plan": ["/request-refactor"],
        "ubiquitous-language": ["/ubiquitous-language"],
    },
}


def inject_triggers(skill_name, content, triggers):
    """Add triggers to YAML frontmatter after description field."""
    if not content.startswith("---"):
        return None

    parts = content.split("---", 2)
    header = parts[1]
    body = parts[2] if len(parts) > 2 else ""

    if "triggers:" in header:
        return None  # already has triggers

    lines = header.split("\n")
    new_lines = []
    found_desc = False
    for line in lines:
        new_lines.append(line)
        stripped = line.strip()
        if stripped.startswith("description:") and not found_desc:
            found_desc = True
            trigger_list = ", ".join(f'"{t}"' for t in triggers)
            new_lines.append(f"triggers: [{trigger_list}]")

    if not found_desc:
        # fallback: add after name
        new_lines.append(f"triggers: [{', '.join(f'\"{t}\"' for t in triggers)}]")

    new_header = "\n".join(new_lines)
    return f"---{new_header}---{body}"


os.makedirs(DST, exist_ok=True)

count = 0
for category, skills in SKILL_TRIGGERS.items():
    for skill_name, triggers in skills.items():
        src_dir = os.path.join(SRC, category, skill_name)
        sk_file = os.path.join(src_dir, "SKILL.md")

        if not os.path.exists(sk_file):
            print(f"  [SKIP] {category}/{skill_name} — SKILL.md not found at {sk_file}")
            continue

        with open(sk_file, "r", encoding="utf-8") as f:
            content = f.read()

        modified = inject_triggers(skill_name, content, triggers)
        if modified is None:
            print(f"  [SKIP] {category}/{skill_name} — already has triggers or bad frontmatter")
            continue

        dst_dir = os.path.join(DST, skill_name)
        os.makedirs(dst_dir, exist_ok=True)

        # Write modified SKILL.md
        with open(os.path.join(dst_dir, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(modified)

        # Copy extra files (scripts/, sub .md files)
        for item in os.listdir(src_dir):
            item_path = os.path.join(src_dir, item)
            if item == "SKILL.md":
                continue
            dst_item = os.path.join(dst_dir, item)
            if os.path.isdir(item_path):
                if os.path.exists(dst_item):
                    shutil.rmtree(dst_item)
                shutil.copytree(item_path, dst_item)
            else:
                shutil.copy2(item_path, dst_item)

        print(f"  [OK]   {category}/{skill_name} → triggers: {triggers}")
        count += 1

print(f"\nInstalled {count} skills to {DST}")
