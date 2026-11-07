"""Databricks job entry point. Run with a consented NDJSON path and MLflow experiment."""
import argparse
import json
import math

import mlflow
import mlflow.pytorch
from mlflow.models import infer_signature
import numpy as np
from pyspark.sql import SparkSession, functions as F
import torch
from torch import nn

HEADINGS = (-60, -45, -30, -15, 0, 15, 30, 45, 60)


def candidate_labels(cells):
    """Label observed corridors only. Unknown space produces a masked label."""
    labels = []
    baseline = []
    for heading in HEADINGS:
        angle = math.radians(heading)
        short, full = [], []
        for step in range(2, 13):
            distance = step * 0.25
            for lateral in (-0.25, 0, 0.25):
                x = math.sin(angle) * distance + math.cos(angle) * lateral
                y = math.cos(angle) * distance - math.sin(angle) * lateral
                col, row = math.floor(20 + x / 0.25), 19 - math.floor(y / 0.25)
                cell = cells[row * 40 + col] if 0 <= col < 40 and 0 <= row < 20 else 0
                full.append(cell)
                if distance <= 1.25:
                    short.append(cell)
        labels.append(0 if 2 in full else -1 if 0 in full else 1)
        baseline.append(int(all(cell == 1 for cell in short)))
    return labels, baseline


def load_rows(path, limit):
    spark = SparkSession.builder.getOrCreate()
    events = spark.read.json(path)
    return (events.filter(
        (F.col("schemaVersion") == 1)
        & (F.col("consent.granted") == True)
        & (F.col("frame.observation.source") == "arkit")
        & (F.size("frame.observation.grid.cells") == 800)
        & (F.size("frame.observation.pose") == 16)
    ).select("sessionId", "sequence", F.col("frame.observation.grid.cells").alias("cells"))
        .dropDuplicates(["sessionId", "sequence"]).limit(limit).collect())


def train(path, experiment, registry, limit):
    rows = load_rows(path, limit)
    sessions = sorted({row.sessionId for row in rows if row.sessionId})
    if len(sessions) < 2:
        raise ValueError("Collect at least two independent consented iPhone sessions.")
    rng = np.random.default_rng(42)
    rng.shuffle(sessions)
    holdout = set(sessions[:max(1, len(sessions) // 5)])
    inputs, targets, baseline, test = [], [], [], []
    for row in rows:
        if not row.sessionId or any(cell not in (0, 1, 2) for cell in row.cells):
            continue
        label, rule = candidate_labels(row.cells)
        if all(value < 0 for value in label):
            continue
        inputs.append(row.cells)
        targets.append(label)
        baseline.append(rule)
        test.append(row.sessionId in holdout)
    test = np.asarray(test, dtype=bool)
    if not test.any() or test.all():
        raise ValueError("Both splits need frames with observed or blocked corridors.")
    x = torch.tensor(np.asarray(inputs, dtype=np.float32).reshape(-1, 1, 20, 40) / 2)
    y = torch.tensor(targets, dtype=torch.float32)
    torch.manual_seed(42)
    network = nn.Sequential(nn.Flatten(), nn.Linear(800, 64), nn.ReLU(), nn.Linear(64, 9), nn.Sigmoid())
    optimizer = torch.optim.Adam(network.parameters(), lr=0.001)
    loss = nn.BCELoss()
    train_x, train_y = x[~test], y[~test]
    generator = torch.Generator().manual_seed(42)
    for _ in range(12):
        for batch in torch.randperm(len(train_x), generator=generator).split(64):
            labels = train_y[batch]
            known = labels >= 0
            error = loss(network(train_x[batch])[known], labels[known])
            optimizer.zero_grad()
            error.backward()
            optimizer.step()
    network.eval()
    with torch.no_grad():
        scores = network(x[test]).numpy()
    labels = y[test].numpy()
    mask = labels >= 0
    blocked = labels == 0
    baseline_prediction = np.asarray(baseline)[test]
    report = {
        "label_source": "geometric candidate labels",
        "heldout_sessions": len(holdout),
        "heldout_frames": int(test.sum()),
        "known_headings": int(mask.sum()),
        "candidate_accuracy": float(((scores >= 0.45)[mask] == labels[mask]).mean()),
        "baseline_accuracy": float((baseline_prediction[mask] == labels[mask]).mean()),
    }
    if blocked.any():
        report["candidate_false_clear_rate"] = float((scores[blocked] >= 0.45).mean())
        report["baseline_false_clear_rate"] = float(baseline_prediction[blocked].mean())

    mlflow.set_experiment(experiment)
    if registry:
        mlflow.set_registry_uri("databricks-uc")
    with mlflow.start_run() as run:
        report["model_version"] = run.info.run_id
        mlflow.log_params({"headings": json.dumps(HEADINGS), "encoding": "cell/2", "label_version": 1})
        mlflow.log_metrics({key: value for key, value in report.items() if isinstance(value, (int, float))})
        mlflow.log_dict(report, "evaluation.json")
        example = x[test][:1].numpy()
        info = mlflow.pytorch.log_model(network, name="traversability", input_example=example,
                                       signature=infer_signature(example, scores[:1]))
        if registry:
            mlflow.register_model(info.model_uri, registry)
        print(json.dumps({"model_uri": info.model_uri, **report}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Consented NDJSON file or Databricks Volume path")
    parser.add_argument("--experiment", required=True)
    parser.add_argument("--register-candidate", help="Unity Catalog name catalog.schema.model")
    parser.add_argument("--limit", type=int, default=10_000)
    args = parser.parse_args()
    train(args.input, args.experiment, args.register_candidate, args.limit)
