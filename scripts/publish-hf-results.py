#!/usr/bin/env python3
"""Idempotently publish one verified AgentBattler dataset release to Hugging Face."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import RepositoryNotFoundError

EXPECTED = {'claude_code_only': 900, 'three_harness': 8100}

def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf8'))

def write_json_atomic(path, value):
    path = Path(path)
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n', encoding='utf8')
    os.replace(temporary, path)

def local_release(staging):
    manifests = list((staging / 'releases').glob('*/release-manifest.json'))
    if len(manifests) != 1:
        raise RuntimeError('expected exactly one local release manifest')
    manifest_path = manifests[0]
    manifest = read_json(manifest_path)
    return manifest_path, manifest, manifest_path.parent

def verify_downloads(repo, release, staging, remote_commit):
    release_path = release['publicationPath']
    allow = ['README.md', 'SHA256SUMS', f'{release_path}/**']
    with tempfile.TemporaryDirectory(prefix='agentbattler-hf-verify-') as temporary:
        remote_root = Path(temporary)
        for relative in ['README.md', 'SHA256SUMS', f'{release_path}/release-manifest.json']:
            hf_hub_download(repo_id=repo, repo_type='dataset', revision=remote_commit, filename=relative, local_dir=remote_root, force_download=True)
            if sha256(remote_root / relative) != sha256(staging / relative):
                raise RuntimeError(f'remote hash mismatch: {relative}')
        remote_manifest = read_json(remote_root / release_path / 'release-manifest.json')
        if remote_manifest != release:
            raise RuntimeError('remote release manifest differs from verified local manifest')
        for config, expected in EXPECTED.items():
            base = f'{release_path}/{config}'
            for relative in [f'{base}/bundle/result.json.gz', f'{base}/bundle/result.json.gz.manifest.json']:
                hf_hub_download(repo_id=repo, repo_type='dataset', revision=remote_commit, filename=relative, local_dir=remote_root, force_download=True)
                if sha256(remote_root / relative) != sha256(staging / relative):
                    raise RuntimeError(f'remote hash mismatch: {relative}')
            parquet_files = sorted(path.relative_to(staging).as_posix() for path in (staging / release_path / config / 'data').glob('*.parquet'))
            identifiers = []
            for relative in parquet_files:
                hf_hub_download(repo_id=repo, repo_type='dataset', revision=remote_commit, filename=relative, local_dir=remote_root, force_download=True)
                table = pq.read_table(remote_root / relative, columns=['game_id'])
                identifiers.extend(table.column('game_id').to_pylist())
            if len(identifiers) != expected or len(set(identifiers)) != expected:
                raise RuntimeError(f'remote Parquet count or game IDs mismatch: {config}')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='.')
    parser.add_argument('--staging', default='.artifacts/hf-dataset/agentbattler-bench-results')
    parser.add_argument('--state', default='.artifacts/hf-publication-state.json')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    staging = (root / args.staging).resolve()
    state_path = (root / args.state).resolve()
    state = read_json(state_path)
    manifest_path, release, release_root = local_release(staging)
    manifest_hash = sha256(manifest_path)
    if state['releaseManifestSha256'] != manifest_hash or state['releaseId'] != release['releaseId'] or state['publicationPath'] != release['publicationPath']:
        raise RuntimeError('local publication state does not match verified release')
    repo = state['datasetRepo']
    if repo != release['datasetRepo']:
        raise RuntimeError('dataset repository differs between state and release')
    api = HfApi()
    try:
        info = api.repo_info(repo, repo_type='dataset')
        files = set(api.list_repo_files(repo, repo_type='dataset'))
        created = False
    except RepositoryNotFoundError:
        api.create_repo(repo_id=repo, repo_type='dataset', private=False, exist_ok=False)
        info = api.repo_info(repo, repo_type='dataset')
        files = set(api.list_repo_files(repo, repo_type='dataset'))
        created = True
    remote_manifest = f"{release['publicationPath']}/release-manifest.json"
    if remote_manifest in files:
        with tempfile.TemporaryDirectory(prefix='agentbattler-hf-reconcile-') as temporary:
            downloaded = hf_hub_download(repo_id=repo, repo_type='dataset', revision=info.sha, filename=remote_manifest, local_dir=temporary, force_download=True)
            if sha256(downloaded) != manifest_hash:
                raise RuntimeError('the canonical remote release path exists with different hashes')
        uploaded = False
    else:
        allowed = ['README.md', 'SHA256SUMS', f"{release['publicationPath']}/**"]
        unexpected = files - {'.gitattributes'}
        if unexpected:
            raise RuntimeError(f'repository exists without this release and is not empty: {sorted(unexpected)}')
        api.upload_folder(repo_id=repo, repo_type='dataset', folder_path=staging, path_in_repo='', allow_patterns=allowed, commit_message=f"Publish AgentBattler {release['releaseId']}")
        uploaded = True
    info = api.repo_info(repo, repo_type='dataset')
    verify_downloads(repo, release, staging, info.sha)
    state['hfCommitSha'] = info.sha
    write_json_atomic(state_path, state)
    print(json.dumps({'repo': repo, 'commit': info.sha, 'releaseId': release['releaseId'], 'created': created, 'uploaded': uploaded}, sort_keys=True))

if __name__ == '__main__':
    main()
