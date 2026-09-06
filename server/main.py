"""
Privacy-Preserving Browser Agent — FastAPI Server

Start: uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""
from __future__ import annotations
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

from app.models.db import init_db
from app.api.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup."""
    await init_db()
    print("[Server] Database initialized")
    print(f"[Server] LLM Provider: {os.getenv('LLM_PROVIDER', 'gemini')}")
    print("[Server] Privacy guarantee: server receives NO raw PII")
    yield
    print("[Server] Shutting down")


app = FastAPI(
    title="Privacy-Preserving Browser Agent",
    description=(
        "Server-side reasoning for the privacy-preserving browser agent. "
        "INVARIANT: This server NEVER receives raw PII. "
        "All sensitive data is detected and redacted locally in the browser before transmission."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow extension and dashboard origins
cors_origins_raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000")
cors_origins = [o.strip() for o in cors_origins_raw.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")
app.include_router(router)  # Fallback for clients calling /action, /verify-pii without /api


@app.get("/")
async def root():
    return {
        "name": "Privacy-Preserving Browser Agent",
        "version": "1.0.0",
        "tagline": "Your browser sees everything. The AI doesn't have to.",
        "privacy_invariant": "Server receives ONLY sanitized context. Raw PII = 0 bytes.",
        "docs": "/docs",
    }
