#!/usr/bin/env python3
# ProxyCLI gRPC helper — 從 stdin 讀 prompt,呼叫 AIProxy.Complete,把回應印到 stdout。
# 由 analyze.js 透過 python3 呼叫。環境變數:AI_PROXY_TOKEN / AI_PROXY_PROJECT(必填)/
# AI_PROXY_GROUP / AI_PROXY_PROVIDER / AI_PROXY_TIER / AI_PROXY_HOST。
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grpc
import aiproxy_pb2 as pb
import aiproxy_pb2_grpc as rpc

def main():
    token = os.environ.get("AI_PROXY_TOKEN", "")
    project = os.environ.get("AI_PROXY_PROJECT", "")
    if not token or "在此填入" in token:
        sys.stderr.write("尚未設定 AI_PROXY_TOKEN(請編輯 .env)")
        sys.exit(2)
    if not project:
        sys.stderr.write("尚未設定 AI_PROXY_PROJECT(請在 ProxyCLI 儀表板建立專案後填入 .env)")
        sys.exit(2)

    prompt = sys.stdin.read()
    host = os.environ.get("AI_PROXY_HOST_PORT", "cli.twloop.com:443")
    group = os.environ.get("AI_PROXY_GROUP") or "backend"
    provider = os.environ.get("AI_PROXY_PROVIDER") or "claude"
    tier = os.environ.get("AI_PROXY_TIER") or "high"

    ch = grpc.secure_channel(host, grpc.ssl_channel_credentials())
    stub = rpc.AIProxyStub(ch)
    max_tokens = int(os.environ.get("AI_PROXY_MAX_TOKENS", "6000"))
    req = pb.CompletionRequest(
        provider=provider, tier=tier, prompt=prompt,
        project=project, group=group, max_tokens=max_tokens,
    )
    md = [("authorization", "Bearer " + token)]
    # 用串流避開 server 端 unary 60 秒上限(產整頁 HTML 會超過)
    try:
        parts = []
        for chunk in stub.StreamComplete(req, metadata=md, timeout=280):
            parts.append(chunk.content)
        sys.stdout.write("".join(parts))
    except grpc.RpcError as e:
        sys.stderr.write(f"ProxyCLI 錯誤 [{e.code().name}]: {e.details()}")
        sys.exit(1)

if __name__ == "__main__":
    main()
