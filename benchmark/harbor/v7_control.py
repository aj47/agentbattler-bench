import base64
import hashlib
import json
import shlex
import tempfile
from pathlib import Path
from pathlib import PurePosixPath


_PREFIX = "AGENTBATTLER_V7_CONTROL_V1 "
def decode_v7_instruction(instruction: str):
    """Split a trusted phase payload from the issue text shown to the model."""
    first, separator, prompt = instruction.partition("\n")
    if not first.startswith(_PREFIX):
        return None, instruction
    if not separator:
        raise ValueError("V7 control envelope is missing its model prompt")
    try:
        raw = base64.b64decode(first[len(_PREFIX) :], validate=True)
        control = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as error:
        raise ValueError("V7 control envelope is malformed") from error
    if control.get("schemaVersion") != "agentbattler.mini-ledger-v7.phase-control.v1":
        raise ValueError("V7 control envelope has an unsupported schema")
    if control.get("phase") not in range(1, 6):
        raise ValueError("V7 control envelope has an invalid phase")
    for field in ("instanceId", "ticket", "ticketSha256", "contract", "contractSha256"):
        if not control.get(field):
            raise ValueError(f"V7 control envelope is missing {field}")
    ticket = control["ticket"].encode("utf-8")
    contract = (json.dumps(control["contract"], sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if hashlib.sha256(ticket).hexdigest() != control["ticketSha256"]:
        raise ValueError("V7 ticket does not match its sealed hash")
    if hashlib.sha256(contract).hexdigest() != control["contractSha256"]:
        raise ValueError("V7 machine-readable contract does not match its sealed hash")
    artifacts = []
    for index, artifact in enumerate(control.get("artifacts") or []):
        relative = artifact.get("path")
        candidate = PurePosixPath(relative) if isinstance(relative, str) else None
        if (
            candidate is None
            or candidate.is_absolute()
            or not candidate.parts
            or any(part in ("", ".", "..") for part in candidate.parts)
            or relative in ("TASK.md", "task-contract.json")
        ):
            raise ValueError(f"V7 control artifact {index} has an unsafe path")
        try:
            payload = base64.b64decode(artifact["bytesBase64"], validate=True)
        except (KeyError, ValueError) as error:
            raise ValueError(f"V7 control artifact {index} has invalid bytes") from error
        if hashlib.sha256(payload).hexdigest() != artifact.get("sha256"):
            raise ValueError(f"V7 control artifact {index} hash mismatch")
        artifacts.append({"path": relative, "bytes": payload})
    return {**control, "contractBytes": contract, "decodedArtifacts": artifacts}, prompt


async def install_v7_control(agent, environment, control) -> None:
    """Install only the current phase as root-owned, read-only control data."""
    if control is None:
        return
    temporary_paths = []
    try:
        for name, payload in (
            ("TASK.md", control["ticket"].encode("utf-8")),
            ("task-contract.json", control["contractBytes"]),
        ):
            with tempfile.NamedTemporaryFile("wb", delete=False) as handle:
                handle.write(payload)
                local = Path(handle.name)
            temporary_paths.append(local)
            await environment.upload_file(local, f"/tmp/agentbattler-v7-{name}")
        artifact_commands = []
        for index, artifact in enumerate(control["decodedArtifacts"]):
            with tempfile.NamedTemporaryFile("wb", delete=False) as handle:
                handle.write(artifact["bytes"])
                local = Path(handle.name)
            temporary_paths.append(local)
            temporary = f"/tmp/agentbattler-v7-artifact-{index}"
            await environment.upload_file(local, temporary)
            target = f"/app/.agentbattler/current/{artifact['path']}"
            artifact_commands.append(
                f"mkdir -p {shlex.quote(str(PurePosixPath(target).parent))}; "
                f"chown 0:0 {shlex.quote(temporary)}; chmod 0444 {shlex.quote(temporary)}; "
                f"mv {shlex.quote(temporary)} {shlex.quote(target)}; "
            )
        await agent.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "for target in /app/.agentbattler/current; do "
                "if mountpoint -q \"$target\"; then umount \"$target\"; fi; "
                "done; "
                "rm -rf /app/.agentbattler/current; "
                "mkdir -p /app/.agentbattler/current; "
                + (
                    "/usr/local/bin/agentbattler-v7-executable-hash "
                    "--workspace /app "
                    "--update-contract /tmp/agentbattler-v7-task-contract.json >/dev/null; "
                    if control["phase"] == 4
                    else ""
                )
                +
                "chown 0:0 /app/.agentbattler /app/.agentbattler/current "
                "/tmp/agentbattler-v7-TASK.md /tmp/agentbattler-v7-task-contract.json; "
                "chmod 0755 /app/.agentbattler /app/.agentbattler/current; "
                "chmod 0444 /tmp/agentbattler-v7-TASK.md /tmp/agentbattler-v7-task-contract.json; "
                "mv /tmp/agentbattler-v7-TASK.md /app/.agentbattler/current/TASK.md; "
                "mv /tmp/agentbattler-v7-task-contract.json /app/.agentbattler/current/task-contract.json; "
                + "".join(artifact_commands)
                +
                "chmod 0555 /app/.agentbattler/current; "
                "mount --bind /app/.agentbattler/current /app/.agentbattler/current; "
                "mount -o remount,bind,ro /app/.agentbattler/current; "
                "test \"$(findmnt -n -o OPTIONS --target /app/.agentbattler/current)\" != \"\"; "
                "findmnt -n -o OPTIONS --target /app/.agentbattler/current | tr ',' '\n' | grep -qx ro; "
                "setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all "
                "/usr/local/bin/agentbattler-v7-control-boundary-probe"
            ),
        )
    finally:
        for temporary_path in temporary_paths:
            temporary_path.unlink(missing_ok=True)
