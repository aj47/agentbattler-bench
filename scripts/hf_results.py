#!/usr/bin/env python3
"""Build and verify a credential-free, Hugging Face-ready AgentBattler dataset."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

SCHEMA = 'agentbattler.hf-game-row.v1'
PACKAGE_SCHEMA = 'agentbattler.hf-results-release.v1'
SECRET = re.compile(r'(?:\bsk-[A-Za-z0-9_-]{20,}|\bbearer\s+[A-Za-z0-9._~+/-]{20,}|(?:access|refresh)[_-]?token|api[_-]?key)\s*["\'=:\s]+[A-Za-z0-9._~+/-]{20,}', re.I)
LOCAL_PATH = re.compile(r'/(?:Users|private|tmp)/')
SUITE_SETS = {
  'current': (
    ('claude_code_only', 'results/claude-code-model-suite/matches', 'agents/claude-code-model-suite/manifest.json', 900, 'results/claude-code-model-suite/generation-suite.json'),
    ('three_harness', 'results/harness-suite/matches', 'agents/harness-suite/manifest.json', 8100, None),
  ),
  'dotagents': (
    ('dotagents_luna', 'results/league/dotagents-placement/matches/luna', 'agents/harness-suite/manifest.json', 180, None),
    ('dotagents_sol', 'results/league/dotagents-placement/matches/sol', 'agents/harness-suite/manifest.json', 180, None),
    ('dotagents_terra', 'results/league/dotagents-placement/matches/terra', 'agents/harness-suite/manifest.json', 180, None),
  ),
}

GAME_SCHEMA = pa.schema([
    pa.field('schema_version', pa.string()), pa.field('suite', pa.string()), pa.field('game_id', pa.string()),
    pa.field('white_agent_id', pa.string()), pa.field('white_display_name', pa.string()), pa.field('white_harness', pa.string()), pa.field('white_model', pa.string()),
    pa.field('black_agent_id', pa.string()), pa.field('black_display_name', pa.string()), pa.field('black_harness', pa.string()), pa.field('black_model', pa.string()),
    pa.field('position_id', pa.string()), pa.field('seed', pa.int64()), pa.field('fen', pa.string()), pa.field('max_plies', pa.int32()),
    pa.field('outcome', pa.string()), pa.field('reason', pa.string()), pa.field('failure_json', pa.string()), pa.field('plies_count', pa.int32()),
    pa.field('game_result_sha256', pa.string()),
    pa.field('game_json', pa.string()),
])

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + '\n', encoding='utf8')

def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def artifact(root, path):
    return {'path': path.as_posix(), 'sha256': sha256_file(root / path), 'sizeBytes': (root / path).stat().st_size}

def clean_provenance(provenance):
    value = dict(provenance or {})
    value.pop('generationMetadata', None)
    return value

def game_row(config, game):
    position = game.get('position', {})
    final = game.get('final', {})
    white = game['agents']['w']
    black = game['agents']['b']
    white_provenance = white.get('provenance', {})
    black_provenance = black.get('provenance', {})
    return {
        'schema_version': SCHEMA, 'suite': config, 'game_id': game['gameId'],
        'white_agent_id': white.get('id'), 'white_display_name': white.get('displayName'), 'white_harness': white_provenance.get('harness'), 'white_model': white_provenance.get('modelRequested'),
        'black_agent_id': black.get('id'), 'black_display_name': black.get('displayName'), 'black_harness': black_provenance.get('harness'), 'black_model': black_provenance.get('modelRequested'),
        'position_id': position.get('id'), 'seed': position.get('seed'), 'fen': position.get('fen'), 'max_plies': position.get('maxPlies'),
        'outcome': final.get('outcome'), 'reason': final.get('reason'), 'failure_json': canonical(final.get('failure')) if final.get('failure') is not None else None,
        'plies_count': len(game.get('plies', [])), 'game_result_sha256': game.get('resultSha256'),
        'game_json': canonical(game),
    }

def copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)

def copy_bundle(root, result_root, destination):
    for relative in ('checksums.json', 'SHA256SUMS', 'positions.json', 'result.json.gz', 'result.json.gz.manifest.json'):
        copy(result_root / relative, destination / relative)
    for source in sorted((result_root / 'agents').glob('*')):
        copy(source, destination / 'agents' / source.name)

def summary_for(result):
    games = result['games']
    return {
        'schemaVersion': 'agentbattler.hf-suite-summary.v1', 'resultSha256': result['resultSha256'],
        'resultFileSha256': None, 'inputs': result['inputs'], 'execution': result['execution'],
        'summary': result['summary'], 'gameCount': len(games),
        'agentFailureCount': sum(1 for game in games if (game.get('final', {}).get('failure') or {}).get('class') == 'agent'),
        'voidCount': sum(1 for game in games if game.get('final', {}).get('outcome') == 'void'),
        'plyCount': sum(len(game.get('plies', [])) for game in games),
    }

def card(release_id, dataset_repo, suites):
    release_path = f'releases/{release_id}'
    configs = ''.join(f'''- config_name: {config}\n  data_files:\n  - split: train\n    path: {release_path}/{config}/data/*.parquet\n''' for config, *_ in suites)
    contents = '\n'.join(f'- `{release_path}/{config}`: {expected:,} games.' for config, _, _, expected, _ in suites)
    return f'''---
pretty_name: AgentBattler Bench results
license: other
tags:
- benchmark
- chess
- coding-agents
configs:
{configs.rstrip()}
---

# AgentBattler Bench results

Release `{release_id}` contains replayable local benchmark bundles and queryable Parquet game tables. Source code and reproduction instructions: https://github.com/aj47/agentbattler-bench.

## Contents

{contents}
- Each `bundle/` stores `result.json.gz`, its deterministic gzip manifest, original bundle checksums, positions, copied agents, and manifest. The uncompressed canonical result is intentionally not duplicated in the dataset tree.

## Data schema

Each Parquet row is one game using `agentbattler.hf-game-row.v1`. Stable queryable fields are suite/game IDs; white/black agent identity, display name, harness, and model; position ID, seed, FEN, and max plies; outcome, reason, failure JSON, plies count, and recorded game-result hash. `game_json` is canonical JSON for the complete recorded game, including every move and nested result field. `summary.json` gives compact aggregates; `release-manifest.json` and `SHA256SUMS` seal the package.

## Reproduction and verification

Use the matching repository revision, then run `npm run verify:hf-results -- --output <downloaded-release-root> --suite-set {release_id.startswith('agentbattler-dotagents-') and 'dotagents' or 'current'}`. This verifies every package hash, Parquet counts/unique game IDs/aggregate counts, deterministic gzip and canonical-result hashes, then replays the compressed bundles against their existing checksums.

## Method, fairness, and security limitations

All agents used the same chess-agent prompt and legal-move contract, six fixed positions, seeded color-balanced pairings, high reasoning where supported, and isolated generation homes. Results are exploratory local evidence, not a claim of general model ability; sequential Elo is order-dependent. Claude Code used a third-party loopback Messages translation gateway to a ChatGPT Codex backend, which Anthropic does not support for non-Claude models. The gateway can introduce translation and tool-semantics differences; it returned agent source in final text with zero recorded tool calls. No Anthropic billing or OpenAI API key was used. Only accepted artifact sources and sanitized provenance are included; raw traces, rejected attempts, credentials, checkpoints, host paths, service logs, and temporary homes are excluded.

## Licensing

This repository has no checked-in LICENSE file. Dataset and generated-agent redistribution rights are therefore not asserted beyond benchmark verification until the maintainers choose and publish a license. `license: other` reflects that restriction.
'''

def scan_public_tree(root):
    for path in root.rglob('*'):
        if not path.is_file() or path.suffix.lower() not in {'.json', '.md', '.js', '.txt'}:
            continue
        content = path.read_text(encoding='utf8')
        if SECRET.search(content):
            raise ValueError(f'potential credential content in {path.relative_to(root)}')
        if LOCAL_PATH.search(content):
            raise ValueError(f'machine-local path in {path.relative_to(root)}')

def verify_sums(root, checksum_file):
    for line in checksum_file.read_text(encoding='utf8').splitlines():
        digest, relative = line.split('  ', 1)
        target = (root / relative).resolve()
        if root.resolve() not in target.parents or sha256_file(target) != digest:
            raise ValueError(f'checksum mismatch: {relative}')

def export(args):
    root = Path(args.root).resolve()
    output = Path(args.output).resolve()
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    release_inputs = []
    config_records = []
    suites = SUITE_SETS[args.suite_set]
    for config, result_relative, manifest_relative, expected, extra in suites:
        result_root = root / result_relative
        result_path = result_root / 'result.json'
        result = json.loads(result_path.read_text(encoding='utf8'))
        if len(result['games']) != expected:
            raise ValueError(f'{config} expected {expected} games, found {len(result["games"])}')
        packed = json.loads((result_root / 'result.json.gz.manifest.json').read_text(encoding='utf8'))
        if packed['canonical']['sha256'] != sha256_file(result_path):
            raise ValueError(f'{config} canonical result hash mismatch')
        config_root = output / config
        copy_bundle(root, result_root, config_root / 'bundle')
        copy(root / manifest_relative, config_root / 'provenance' / 'suite-manifest.json')
        manifest = json.loads((root / manifest_relative).read_text(encoding='utf8'))
        accepted = {'schemaVersion': 'agentbattler.accepted-agent-provenance.v1', 'manifestId': manifest['manifestId'], 'agents': [{**{key: agent.get(key) for key in ('id', 'displayName', 'role', 'sizeBytes', 'sourceSha256')}, 'provenance': clean_provenance(agent.get('provenance'))} for agent in manifest['agents']]}
        write_json(config_root / 'provenance' / 'accepted-agent-provenance.json', accepted)
        if extra:
            copy(root / extra, config_root / 'provenance' / 'generation-suite.json')
        summary = summary_for(result)
        summary['resultFileSha256'] = packed['canonical']['sha256']
        write_json(config_root / 'summary.json', summary)
        data_dir = config_root / 'data'
        data_dir.mkdir(parents=True, exist_ok=True)
        rows = [game_row(config, game) for game in result['games']]
        for index in range(0, len(rows), 2000):
            table = pa.Table.from_pylist(rows[index:index + 2000], schema=GAME_SCHEMA)
            pq.write_table(table, data_dir / f'part-{index // 2000:05d}.parquet', compression='zstd', row_group_size=256, version='2.6')
        release_inputs.append({'config': config, 'canonicalResultSha256': packed['canonical']['sha256'], 'canonicalResultSizeBytes': packed['canonical']['sizeBytes'], 'resultSha256': result['resultSha256']})
        config_records.append({'config': config, 'expectedGames': expected, 'bundle': {name: artifact(config_root, Path('bundle') / name) for name in ('result.json.gz', 'result.json.gz.manifest.json', 'checksums.json', 'SHA256SUMS')}, 'summary': artifact(config_root, Path('summary.json'))})
    prefix = 'agentbattler-dotagents-v1-' if args.suite_set == 'dotagents' else 'agentbattler-hf-v1-'
    release_id = prefix + hashlib.sha256(canonical(sorted(release_inputs, key=lambda item: item['config'])).encode()).hexdigest()[:20]
    git_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    git_branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip()
    release = {'schemaVersion': PACKAGE_SCHEMA, 'releaseId': release_id, 'datasetRepo': args.dataset_repo, 'source': {'repository': 'https://github.com/aj47/agentbattler-bench', 'gitCommit': git_commit}, 'tools': {'python': sys.version.split()[0], 'pyarrow': pa.__version__}, 'configs': config_records, 'releaseInputs': release_inputs, 'publicationPath': f'releases/{release_id}'}
    release_root = output / 'releases' / release_id
    release_root.mkdir(parents=True, exist_ok=True)
    for config, *_ in suites:
        shutil.move(str(output / config), str(release_root / config))
    write_json(release_root / 'release-manifest.json', release)
    state_path = root / '.artifacts' / 'hf-publication-state.json'
    write_json(state_path, {'schemaVersion': 'agentbattler.hf-publication-state.v1', 'datasetRepo': args.dataset_repo, 'releaseId': release_id, 'publicationPath': release['publicationPath'], 'releaseManifestSha256': sha256_file(release_root / 'release-manifest.json'), 'hfCommitSha': None, 'githubBranch': git_branch, 'githubPullRequestUrl': None})
    (output / 'README.md').write_text(card(release_id, args.dataset_repo, suites), encoding='utf8')
    scan_public_tree(output)
    release_paths = [path for path in sorted(release_root.rglob('*')) if path.is_file() and path.name != 'SHA256SUMS']
    (release_root / 'SHA256SUMS').write_text(''.join(f'{sha256_file(path)}  {path.relative_to(release_root).as_posix()}\n' for path in release_paths), encoding='utf8')
    paths = [path for path in sorted(output.rglob('*')) if path.is_file() and path.name != 'SHA256SUMS']
    (output / 'SHA256SUMS').write_text(''.join(f'{sha256_file(path)}  {path.relative_to(output).as_posix()}\n' for path in paths), encoding='utf8')
    print(json.dumps({'output': str(output), 'releaseId': release_id, 'publicationPath': release['publicationPath'], 'configs': {item['config']: item['expectedGames'] for item in config_records}}, sort_keys=True))

def verify(args):
    output = Path(args.output).resolve()
    manifests = list(output.glob('releases/*/release-manifest.json'))
    if len(manifests) != 1:
        raise ValueError('expected exactly one staged release manifest')
    release_root = manifests[0].parent
    release = json.loads(manifests[0].read_text(encoding='utf8'))
    if release.get('schemaVersion') != PACKAGE_SCHEMA:
        raise ValueError('unsupported release manifest schema')
    verify_sums(output, output / 'SHA256SUMS')
    verify_sums(release_root, release_root / 'SHA256SUMS')
    for config, _, _, expected, _ in SUITE_SETS[args.suite_set]:
        config_root = release_root / config
        packed = json.loads((config_root / 'bundle' / 'result.json.gz.manifest.json').read_text(encoding='utf8'))
        gzip_path = config_root / 'bundle' / 'result.json.gz'
        if sha256_file(gzip_path) != packed['compressed']['sha256'] or gzip_path.stat().st_size != packed['compressed']['sizeBytes']:
            raise ValueError(f'{config} gzip manifest mismatch')
        parquet_paths = sorted((config_root / 'data').glob('*.parquet'))
        rows = []
        for parquet_path in parquet_paths:
            rows.extend(pq.read_table(parquet_path).to_pylist())
        game_ids = [row['game_id'] for row in rows]
        if len(rows) != expected or len(set(game_ids)) != expected:
            raise ValueError(f'{config} Parquet count or game IDs mismatch')
        for row in rows:
            game = json.loads(row['game_json'])
            if game.get('gameId') != row['game_id'] or game.get('resultSha256') != row['game_result_sha256']:
                raise ValueError(f'{config} Parquet game projection mismatch')
        summary = json.loads((config_root / 'summary.json').read_text(encoding='utf8'))
        if summary['gameCount'] != len(rows) or summary['voidCount'] != sum(row['outcome'] == 'void' for row in rows) or summary['plyCount'] != sum(row['plies_count'] for row in rows):
            raise ValueError(f'{config} aggregate summary mismatch')
    scan_public_tree(output)
    print(json.dumps({'verifiedReleaseId': release['releaseId'], 'datasetRepo': release['datasetRepo']}, sort_keys=True))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('export', 'verify'))
    parser.add_argument('--root', default='.')
    parser.add_argument('--output', default='.artifacts/hf-dataset/agentbattler-bench-results')
    parser.add_argument('--dataset-repo', default='techfren/agentbattler-bench-results')
    parser.add_argument('--suite-set', choices=tuple(SUITE_SETS), default='current')
    args = parser.parse_args()
    (export if args.command == 'export' else verify)(args)

if __name__ == '__main__':
    main()
