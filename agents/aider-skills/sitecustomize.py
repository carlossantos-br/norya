"""Adapter for Aider's read-only context. Loaded only in Norya Aider processes.

The installed CLI and its settings stay untouched. /skill NAME or $NAME loads
the original skill and keeps relative resource paths meaningful. No LLM call.
"""
import json
import os
import re
import sys


def catalog():
    with open(os.environ["NORYA_SKILLS_CATALOG"], encoding="utf-8") as stream:
        return json.load(stream)["skills"]


def sync_skills(coder, message="", explicit=None):
    skills = catalog()  # Fail closed: corrupted state never enables skills.
    tracked = getattr(coder, "_norya_skill_files", set())
    enabled = {os.path.realpath(s["path"]) for s in skills if s["enabled"]}
    for filename in tracked - enabled:
        coder.abs_read_only_fnames.discard(filename)
    tracked &= enabled
    loaded = []
    for skill in skills:
        name = skill["name"]
        named = explicit == name or re.search(r"(?<![\w-])\$" + re.escape(name) + r"(?![\w-])", message)
        if not named:
            continue
        if not skill["enabled"]:
            coder.io.tool_error(f"Skill desabilitada no Norya: {name}")
            continue
        filename = os.path.realpath(skill["path"])
        if not os.path.isfile(filename):
            coder.io.tool_error(f"Skill não encontrada. Atualize a biblioteca: {name}")
            continue
        coder.abs_read_only_fnames.add(filename)
        tracked.add(filename)
        loaded.append(name)
    coder._norya_skill_files = tracked
    return loaded


def install():
    from aider.coders.base_coder import Coder
    from aider.commands import Commands

    original = Coder.run_one

    def run_one(self, user_message, preproc):
        try:
            loaded = sync_skills(self, user_message or "")
            if loaded:
                self.io.tool_output("Skills do Norya: " + ", ".join(loaded))
        except (OSError, ValueError, KeyError) as error:
            self.io.tool_error(f"Não foi possível ler as skills do Norya: {error}")
            return
        return original(self, user_message, preproc)

    def cmd_skill(self, args):
        "Use /skill nome para carregar uma skill habilitada na biblioteca do Norya."
        try:
            if not args.strip():
                self.io.tool_output("Skills habilitadas: " + ", ".join(s["name"] for s in catalog() if s["enabled"]))
                return
            loaded = sync_skills(self.coder, explicit=args.strip())
            if loaded:
                self.io.tool_output("Skill carregada: " + ", ".join(loaded))
            else:
                self.io.tool_error("Skill indisponível. Confira o nome e a ativação na biblioteca do Norya.")
        except (OSError, ValueError, KeyError) as error:
            self.io.tool_error(f"Não foi possível ler as skills do Norya: {error}")

    Coder.run_one = run_one
    Coder._norya_skills_adapter = True
    Commands.cmd_skill = cmd_skill


if os.environ.get("NORYA_SKILLS_CATALOG") and os.path.basename(sys.argv[0]).startswith("aider"):
    try:
        install()
    except ImportError as error:
        print(f"Norya: adaptador de skills do Aider indisponível: {error}", file=sys.stderr)
