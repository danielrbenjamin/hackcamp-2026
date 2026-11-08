# Databricks notebook source
# /// script
# [tool.databricks.environment]
# base_environment = "databricks_ai_v6"
# environment_version = "6"
# dependencies = [
#   "transformers",
#   "torch",
#   "pillow",
#   "matplotlib",
#   "numpy",
#   "mlflow",
# ]
# ///
from pathlib import Path, PurePosixPath
import json
import random
import re
import zipfile
from collections import Counter, defaultdict

ROOT = Path("/Volumes/workspace/default/stair_sample")
archives = sorted(ROOT.glob("*.zip"))
assert len(archives) == 1, f"Upload exactly one ZIP to {ROOT}. Found: {[p.name for p in archives]}"
ZIP_PATH = archives[0]

hints = {
    "rgb": {"rgb", "color", "colour", "image", "images", "img", "left"},
        "depth": {"depth", "depths", "dep", "disparity"},
            "mask": {"mask", "masks", "label", "labels", "annotation", "annotations", "seg", "segmentation", "semantic", "groundtruth", "ground_truth", "gt"},
            }
            all_hints = set().union(*hints.values())
            extensions = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}

            def tokens(value):
                return [part for part in re.split(r"[^a-z0-9]+", value.lower()) if part]

                def modality(member):
                    path = PurePosixPath(member.replace("\\", "/"))
                        found = set()
                            for part in path.parts:
                                    found.update(tokens(PurePosixPath(part).stem))
                                        if found & hints["mask"]:
                                                return "mask"
                                                    if found & hints["depth"]:
                                                            return "depth"
                                                                if found & hints["rgb"]:
                                                                        return "rgb"
                                                                            return None

                                                                            def sample_key(member):
                                                                                path = PurePosixPath(member.replace("\\", "/"))
                                                                                    clean = []
                                                                                        for part in path.with_suffix("").parts:
                                                                                                kept = [token for token in tokens(part) if token not in all_hints]
                                                                                                        if kept:
                                                                                                                    clean.append("_".join(kept))
                                                                                                                        return "/".join(clean)

                                                                                                                        with zipfile.ZipFile(ZIP_PATH) as archive:
                                                                                                                            members = [item.filename for item in archive.infolist() if not item.is_dir()]

                                                                                                                            groups = defaultdict(lambda: {"rgb": [], "depth": [], "mask": []})
                                                                                                                            unclassified = []
                                                                                                                            counts = Counter()
                                                                                                                            for member in members:
                                                                                                                                if PurePosixPath(member).suffix.lower() not in extensions:
                                                                                                                                        continue
                                                                                                                                            kind = modality(member)
                                                                                                                                                if kind is None:
                                                                                                                                                        unclassified.append(member)
                                                                                                                                                                continue
                                                                                                                                                                    counts[kind] += 1
                                                                                                                                                                        groups[sample_key(member)][kind].append(member)

                                                                                                                                                                        triplets = []
                                                                                                                                                                        for key, group in sorted(groups.items()):
                                                                                                                                                                            if all(len(group[kind]) == 1 for kind in ("rgb", "depth", "mask")):
                                                                                                                                                                                    triplets.append({"key": key, "rgb": group["rgb"][0], "depth": group["depth"][0], "mask": group["mask"][0]})

                                                                                                                                                                                    report = {
                                                                                                                                                                                        "zip": ZIP_PATH.name,
                                                                                                                                                                                            "files": len(members),
                                                                                                                                                                                                "modality_counts": dict(counts),
                                                                                                                                                                                                    "matched_triplets": len(triplets),
                                                                                                                                                                                                        "first_files": members[:30],
                                                                                                                                                                                                            "matched_examples": triplets[:5],
                                                                                                                                                                                                                "unclassified_examples": unclassified[:30],
                                                                                                                                                                                                                }
                                                                                                                                                                                                                print(json.dumps(report, indent=2))

# COMMAND ----------

# MAGIC
# MAGIC %pip install transformers torch pillow matplotlib
# MAGIC

# COMMAND ----------

import torch
import transformers
import matplotlib
from PIL import Image

print("PyTorch:", torch.__version__)

# COMMAND ----------


from transformers import (
    AutoImageProcessor,
    SegformerForSemanticSegmentation
)
import torch
import numpy as np
from PIL import Image
import matplotlib.pyplot as plt

MODEL_NAME = "nvidia/segformer-b0-finetuned-ade-512-512"

processor = AutoImageProcessor.from_pretrained(
    MODEL_NAME
)

model = SegformerForSemanticSegmentation.from_pretrained(
    MODEL_NAME
)
model.eval()

stair_ids = [
    int(idx)
    for idx, label in model.config.id2label.items()
    if "stair" in label.lower()
]

print("Stair class IDs:", stair_ids)


# COMMAND ----------

from pathlib import Path
ROOT = Path("/Volumes/workspace/default/stair_sample")
for file in ROOT.iterdir():
    print(file.name)

# COMMAND ----------


from PIL import Image
import numpy as np
import matplotlib.pyplot as plt
def load_sample(prefix):
    files = list(ROOT.glob(prefix + ".*"))
    assert len(files) == 1, f"Check file named {prefix}"
    return np.array(Image.open(files[0]))
rgb = load_sample("rgb_sample")
depth = load_sample("depth_sample")
mask = load_sample("mask_sample")
fig, axes = plt.subplots(1, 3, figsize=(12, 4))
for ax, data, title in zip(
    axes,
    [rgb, depth, mask],
    ["RGB", "Depth", "Stair labels"]
):
    ax.imshow(data)
    ax.set_title(title)
    ax.axis("off")

plt.show()

# COMMAND ----------


print("RGB shape:", rgb.shape)
print("Depth shape:", depth.shape)
print("Mask shape:", mask.shape)

# COMMAND ----------

import json
import mlflow
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

IMAGE_SIZE = 256
BATCH_SIZE = 8
EPOCHS = 8
LEARNING_RATE = 0.001
NUM_CLASSES = 2
MANIFEST_PATH = OUTPUT / "manifest.jsonl"
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

class StairDataset(Dataset):
    def __init__(self, manifest_path, split):
        rows = [
            json.loads(line)
            for line in Path(manifest_path).read_text().splitlines()
            if line.strip()
        ]
        self.rows = [row for row in rows if row["split"] == split]

    def __len__(self):
        return len(self.rows)

    def resolve_path(self, value):
        path = Path(value)
        if path.exists():
            return path
        return OUTPUT / path

    def __getitem__(self, index):
        row = self.rows[index]

        rgb = Image.open(self.resolve_path(row["rgb"])).convert("RGB")
        rgb = rgb.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.BILINEAR
        )
        rgb = np.asarray(rgb, dtype=np.float32) / 255.0

        depth = Image.open(self.resolve_path(row["depth"]))
        depth = depth.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.BILINEAR
        )
        depth = np.asarray(depth, dtype=np.float32)

        if depth.ndim == 3:
            depth = depth[:, :, 0]

        valid_depth = depth[np.isfinite(depth) & (depth > 0)]

        if valid_depth.size:
            low, high = np.percentile(valid_depth, [1, 99])
            depth = np.clip(depth, low, high)
            depth = (depth - low) / max(high - low, 1e-6)
        else:
            depth = np.zeros_like(depth)

        mask = Image.open(self.resolve_path(row["mask"]))
        mask = mask.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.NEAREST
        )
        mask = np.asarray(mask)

        if mask.ndim == 3:
            mask = mask[:, :, 0]

        mask = (mask > 0).astype(np.int64)

        image = np.concatenate([rgb, depth[:, :, None]], axis=2)
        image = torch.from_numpy(image.transpose(2, 0, 1)).float()
        mask = torch.from_numpy(mask).long()

        return image, mask

class ConvBlock(nn.Module):
    def __init__(self, input_channels, output_channels):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(input_channels, output_channels, 3, padding=1),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(output_channels, output_channels, 3, padding=1),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=True)
        )

    def forward(self, x):
        return self.layers(x)

class RGBDUNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder1 = ConvBlock(4, 16)
        self.encoder2 = ConvBlock(16, 32)
        self.bottleneck = ConvBlock(32, 64)
        self.pool = nn.MaxPool2d(2)
        self.up2 = nn.ConvTranspose2d(64, 32, 2, stride=2)
        self.decoder2 = ConvBlock(64, 32)
        self.up1 = nn.ConvTranspose2d(32, 16, 2, stride=2)
        self.decoder1 = ConvBlock(32, 16)
        self.output = nn.Conv2d(16, NUM_CLASSES, 1)

    def forward(self, x):
        encoder1 = self.encoder1(x)
        encoder2 = self.encoder2(self.pool(encoder1))
        bottleneck = self.bottleneck(self.pool(encoder2))
        decoder2 = self.decoder2(
            torch.cat([self.up2(bottleneck), encoder2], dim=1)
        )
        decoder1 = self.decoder1(
            torch.cat([self.up1(decoder2), encoder1], dim=1)
        )
        return self.output(decoder1)

def evaluate(model, loader, criterion):
    model.eval()
    total_loss = 0.0
    intersection = 0
    union = 0
    correct = 0
    pixels = 0

    with torch.no_grad():
        for images, masks in loader:
            images = images.to(DEVICE)
            masks = masks.to(DEVICE)

            logits = model(images)
            loss = criterion(logits, masks)
            predictions = logits.argmax(dim=1)

            total_loss += loss.item()
            intersection += ((predictions == 1) & (masks == 1)).sum().item()
            union += ((predictions == 1) | (masks == 1)).sum().item()
            correct += (predictions == masks).sum().item()
            pixels += masks.numel()

    return {
        "loss": total_loss / max(len(loader), 1),
        "stair_iou": intersection / max(union, 1),
        "pixel_accuracy": correct / max(pixels, 1)
    }

train_dataset = StairDataset(MANIFEST_PATH, "train")
validation_dataset = StairDataset(MANIFEST_PATH, "validation")

train_loader = DataLoader(
    train_dataset,
    batch_size=BATCH_SIZE,
    shuffle=True,
    num_workers=0
)

validation_loader = DataLoader(
    validation_dataset,
    batch_size=BATCH_SIZE,
    shuffle=False,
    num_workers=0
)

model = RGBDUNet().to(DEVICE)
criterion = nn.CrossEntropyLoss()
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=LEARNING_RATE
)

checkpoint_path = OUTPUT / "best_rgbd_stair_model.pt"
best_iou = -1.0

with mlflow.start_run() as run:
    mlflow.log_params({
        "image_size": IMAGE_SIZE,
        "batch_size": BATCH_SIZE,
        "epochs": EPOCHS,
        "learning_rate": LEARNING_RATE,
        "train_examples": len(train_dataset),
        "validation_examples": len(validation_dataset),
        "device": str(DEVICE),
        "input_channels": 4,
        "classes": NUM_CLASSES
    })

    for epoch in range(EPOCHS):
        model.train()
        total_training_loss = 0.0

        for images, masks in train_loader:
            images = images.to(DEVICE)
            masks = masks.to(DEVICE)

            optimizer.zero_grad()
            logits = model(images)
            loss = criterion(logits, masks)
            loss.backward()
            optimizer.step()

            total_training_loss += loss.item()

        training_loss = total_training_loss / max(len(train_loader), 1)
        validation_metrics = evaluate(
            model,
            validation_loader,
            criterion
        )

        mlflow.log_metrics({
            "training_loss": training_loss,
            "validation_loss": validation_metrics["loss"],
            "validation_stair_iou": validation_metrics["stair_iou"],
            "validation_pixel_accuracy": validation_metrics["pixel_accuracy"]
        }, step=epoch + 1)

        if validation_metrics["stair_iou"] > best_iou:
            best_iou = validation_metrics["stair_iou"]
            torch.save({
                "model_state_dict": model.state_dict(),
                "image_size": IMAGE_SIZE,
                "input_channels": 4,
                "classes": NUM_CLASSES,
                "validation_stair_iou": best_iou
            }, checkpoint_path)

        print({
            "epoch": epoch + 1,
            "training_loss": round(training_loss, 4),
            "validation_loss": round(validation_metrics["loss"], 4),
            "validation_stair_iou": round(validation_metrics["stair_iou"], 4),
            "validation_pixel_accuracy": round(
                validation_metrics["pixel_accuracy"],
                4
            )
        })

    mlflow.log_metric("best_validation_stair_iou", best_iou)
    mlflow.log_artifact(str(checkpoint_path))
    mlflow.log_artifact(str(MANIFEST_PATH))

    print("Best stair IoU:", best_iou)
    print("Model:", checkpoint_path)
    print("MLflow run:", run.info.run_id)

# COMMAND ----------

# MAGIC %pip install torch pillow numpy mlflow

# COMMAND ----------

from pathlib import Path, PurePosixPath
from collections import defaultdict
import json
import random
import re
import shutil
import zipfile
import mlflow
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

ROOT = Path("/Volumes/workspace/default/stair_sample")
OUTPUT = ROOT / "prepared_stairs"
MANIFEST_PATH = OUTPUT / "manifest.jsonl"
TRAIN_COUNT = 100
VALIDATION_COUNT = 30
SEED = 42
IMAGE_SIZE = 256
BATCH_SIZE = 8
EPOCHS = 8
LEARNING_RATE = 0.001
NUM_CLASSES = 2
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

zip_files = sorted(
    ROOT.rglob("*.zip"),
    key=lambda path: path.stat().st_size,
    reverse=True
)

if not zip_files:
    raise FileNotFoundError(
        f"Upload the original RGB-D Stair dataset ZIP to {ROOT}"
    )

ZIP_PATH = zip_files[0]

image_extensions = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".tif",
    ".tiff"
}

rgb_words = {
    "rgb",
    "color",
    "colour",
    "image",
    "images"
}

depth_words = {
    "depth",
    "depths",
    "depthes",
    "distance"
}

mask_words = {
    "mask",
    "masks",
    "seg",
    "segmentation",
    "segmentations",
    "label",
    "labels",
    "annotation",
    "annotations",
    "groundtruth",
    "ground",
    "truth",
    "gt"
}

all_modality_words = rgb_words | depth_words | mask_words

def tokenize(value):
    return [
        token
        for token in re.split(r"[^a-z0-9]+", value.lower())
        if token
    ]

def modality(filename):
    tokens = set(tokenize(filename))

    if tokens & mask_words:
        return "mask"

    if tokens & depth_words:
        return "depth"

    if tokens & rgb_words:
        return "rgb"

    return None

def sample_key(filename):
    path = PurePosixPath(filename)
    cleaned_parts = []

    for part in path.with_suffix("").parts:
        tokens = tokenize(part)
        tokens = [
            token
            for token in tokens
            if token not in all_modality_words
        ]

        if tokens:
            cleaned_parts.append("_".join(tokens))

    return "/".join(cleaned_parts)

with zipfile.ZipFile(ZIP_PATH) as archive:
    members = [
        member
        for member in archive.namelist()
        if not member.endswith("/")
        and PurePosixPath(member).suffix.lower() in image_extensions
    ]

groups = defaultdict(dict)
unclassified = []

for member in members:
    kind = modality(member)

    if kind is None:
        unclassified.append(member)
        continue

    key = sample_key(member)

    if key:
        groups[key][kind] = member

triplets = [
    {
        "key": key,
        "rgb": files["rgb"],
        "depth": files["depth"],
        "mask": files["mask"]
    }
    for key, files in groups.items()
    if {"rgb", "depth", "mask"}.issubset(files)
]

valid_triplets = []
rejected_triplets = []

with zipfile.ZipFile(ZIP_PATH) as archive:
    for triplet in triplets:
        try:
            with archive.open(triplet["rgb"]) as stream:
                rgb_size = Image.open(stream).size

            with archive.open(triplet["depth"]) as stream:
                depth_size = Image.open(stream).size

            with archive.open(triplet["mask"]) as stream:
                mask_size = Image.open(stream).size

            if rgb_size != depth_size or rgb_size != mask_size:
                raise ValueError(
                    f"{rgb_size}, {depth_size}, {mask_size}"
                )

            valid_triplets.append(triplet)

        except Exception as error:
            rejected_triplets.append({
                "key": triplet["key"],
                "error": str(error)
            })

required_count = TRAIN_COUNT + VALIDATION_COUNT

if len(valid_triplets) < required_count:
    raise ValueError(
        f"Found {len(valid_triplets)} matched rgbd examples"
        f"At least {required_count} are required"
        f"the zip used: {ZIP_PATH.name}"
    )

random.Random(SEED).shuffle(valid_triplets)
selected_triplets = valid_triplets[:required_count]

splits = {
    "train": selected_triplets[:TRAIN_COUNT],
    "validation": selected_triplets[
        TRAIN_COUNT:TRAIN_COUNT + VALIDATION_COUNT
    ]
}

for split in splits:
    for kind in ("rgb", "depth", "mask"):
        (OUTPUT / split / kind).mkdir(
            parents=True,
            exist_ok=True
        )

manifest_rows = []

with zipfile.ZipFile(ZIP_PATH) as archive:
    for split, items in splits.items():
        for index, item in enumerate(items):
            row = {
                "split": split,
                "key": item["key"]
            }

            for kind in ("rgb", "depth", "mask"):
                source_name = item[kind]
                extension = PurePosixPath(source_name).suffix.lower()
                destination = (
                    OUTPUT
                    / split
                    / kind
                    / f"{index:04d}{extension}"
                )

                with archive.open(source_name) as source:
                    with destination.open("wb") as target:
                        shutil.copyfileobj(source, target)

                row[kind] = str(destination)

            manifest_rows.append(row)

with MANIFEST_PATH.open("w", encoding="utf-8") as manifest:
    for row in manifest_rows:
        manifest.write(json.dumps(row) + "\n")

summary = {
    "zip": str(ZIP_PATH),
    "archive_images": len(members),
    "matched_triplets": len(triplets),
    "valid_triplets": len(valid_triplets),
    "rejected_triplets": len(rejected_triplets),
    "training_examples": TRAIN_COUNT,
    "validation_examples": VALIDATION_COUNT,
    "output": str(OUTPUT)
}

(OUTPUT / "summary.json").write_text(
    json.dumps(summary, indent=2),
    encoding="utf-8"
)

print(json.dumps(summary, indent=2))

class StairDataset(Dataset):
    def __init__(self, manifest_path, split):
        rows = [
            json.loads(line)
            for line in Path(manifest_path).read_text().splitlines()
            if line.strip()
        ]

        self.rows = [
            row
            for row in rows
            if row["split"] == split
        ]

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]

        rgb = Image.open(row["rgb"]).convert("RGB")
        rgb = rgb.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.BILINEAR
        )
        rgb = np.asarray(rgb, dtype=np.float32) / 255.0

        depth = Image.open(row["depth"])
        depth = depth.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.BILINEAR
        )
        depth = np.asarray(depth, dtype=np.float32)

        if depth.ndim == 3:
            depth = depth[:, :, 0]

        valid_depth = depth[
            np.isfinite(depth) & (depth > 0)
        ]

        if valid_depth.size:
            low, high = np.percentile(
                valid_depth,
                [1, 99]
            )
            depth = np.clip(depth, low, high)
            depth = (depth - low) / max(high - low, 1e-6)
            depth = np.nan_to_num(depth)
        else:
            depth = np.zeros_like(depth)

        mask = Image.open(row["mask"])
        mask = mask.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.NEAREST
        )
        mask = np.asarray(mask)

        if mask.ndim == 3:
            mask = np.any(mask != 0, axis=2)
        else:
            mask = mask != 0

        mask = mask.astype(np.int64)

        image = np.concatenate(
            [rgb, depth[:, :, None]],
            axis=2
        )

        image = torch.from_numpy(
            image.transpose(2, 0, 1)
        ).float()

        mask = torch.from_numpy(mask).long()

        return image, mask

class ConvBlock(nn.Module):
    def __init__(self, input_channels, output_channels):
        super().__init__()

        self.layers = nn.Sequential(
            nn.Conv2d(
                input_channels,
                output_channels,
                3,
                padding=1
            ),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(
                output_channels,
                output_channels,
                3,
                padding=1
            ),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=True)
        )

    def forward(self, x):
        return self.layers(x)

class RGBDUNet(nn.Module):
    def __init__(self):
        super().__init__()

        self.encoder1 = ConvBlock(4, 16)
        self.encoder2 = ConvBlock(16, 32)
        self.bottleneck = ConvBlock(32, 64)
        self.pool = nn.MaxPool2d(2)
        self.up2 = nn.ConvTranspose2d(
            64,
            32,
            2,
            stride=2
        )
        self.decoder2 = ConvBlock(64, 32)
        self.up1 = nn.ConvTranspose2d(
            32,
            16,
            2,
            stride=2
        )
        self.decoder1 = ConvBlock(32, 16)
        self.output = nn.Conv2d(
            16,
            NUM_CLASSES,
            1
        )

    def forward(self, x):
        encoder1 = self.encoder1(x)
        encoder2 = self.encoder2(
            self.pool(encoder1)
        )
        bottleneck = self.bottleneck(
            self.pool(encoder2)
        )
        decoder2 = self.up2(bottleneck)
        decoder2 = torch.cat(
            [decoder2, encoder2],
            dim=1
        )
        decoder2 = self.decoder2(decoder2)
        decoder1 = self.up1(decoder2)
        decoder1 = torch.cat(
            [decoder1, encoder1],
            dim=1
        )
        decoder1 = self.decoder1(decoder1)

        return self.output(decoder1)

def evaluate(model, loader, criterion):
    model.eval()

    total_loss = 0.0
    intersection = 0
    union = 0
    correct = 0
    pixels = 0

    with torch.no_grad():
        for images, masks in loader:
            images = images.to(DEVICE)
            masks = masks.to(DEVICE)

            logits = model(images)
            loss = criterion(logits, masks)
            predictions = logits.argmax(dim=1)

            total_loss += loss.item()

            intersection += (
                (predictions == 1)
                & (masks == 1)
            ).sum().item()

            union += (
                (predictions == 1)
                | (masks == 1)
            ).sum().item()

            correct += (
                predictions == masks
            ).sum().item()

            pixels += masks.numel()

    return {
        "loss": total_loss / max(len(loader), 1),
        "stair_iou": intersection / max(union, 1),
        "pixel_accuracy": correct / max(pixels, 1)
    }

train_dataset = StairDataset(
    MANIFEST_PATH,
    "train"
)

validation_dataset = StairDataset(
    MANIFEST_PATH,
    "validation"
)

train_loader = DataLoader(
    train_dataset,
    batch_size=BATCH_SIZE,
    shuffle=True,
    num_workers=0
)

validation_loader = DataLoader(
    validation_dataset,
    batch_size=BATCH_SIZE,
    shuffle=False,
    num_workers=0
)

model = RGBDUNet().to(DEVICE)
criterion = nn.CrossEntropyLoss()

optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=LEARNING_RATE
)

checkpoint_path = (
    OUTPUT / "best_rgbd_stair_model.pt"
)

best_iou = -1.0

with mlflow.start_run() as run:
    mlflow.log_params({
        "image_size": IMAGE_SIZE,
        "batch_size": BATCH_SIZE,
        "epochs": EPOCHS,
        "learning_rate": LEARNING_RATE,
        "training_examples": len(train_dataset),
        "validation_examples": len(validation_dataset),
        "device": str(DEVICE),
        "input_channels": 4,
        "classes": NUM_CLASSES
    })

    for epoch in range(EPOCHS):
        model.train()
        total_training_loss = 0.0

        for images, masks in train_loader:
            images = images.to(DEVICE)
            masks = masks.to(DEVICE)

            optimizer.zero_grad()

            logits = model(images)
            loss = criterion(logits, masks)

            loss.backward()
            optimizer.step()

            total_training_loss += loss.item()

        training_loss = (
            total_training_loss
            / max(len(train_loader), 1)
        )

        validation_metrics = evaluate(
            model,
            validation_loader,
            criterion
        )

        mlflow.log_metrics({
            "training_loss": training_loss,
            "validation_loss": validation_metrics["loss"],
            "validation_stair_iou": validation_metrics["stair_iou"],
            "validation_pixel_accuracy": validation_metrics[
                "pixel_accuracy"
            ]
        }, step=epoch + 1)

        if validation_metrics["stair_iou"] > best_iou:
            best_iou = validation_metrics["stair_iou"]

            torch.save({
                "model_state_dict": model.state_dict(),
                "image_size": IMAGE_SIZE,
                "input_channels": 4,
                "classes": NUM_CLASSES,
                "validation_stair_iou": best_iou
            }, checkpoint_path)

        print({
            "epoch": epoch + 1,
            "training_loss": round(
                training_loss,
                4
            ),
            "validation_loss": round(
                validation_metrics["loss"],
                4
            ),
            "validation_stair_iou": round(
                validation_metrics["stair_iou"],
                4
            ),
            "validation_pixel_accuracy": round(
                validation_metrics["pixel_accuracy"],
                4
            )
        })

    mlflow.log_metric(
        "best_validation_stair_iou",
        best_iou
    )

    mlflow.log_artifact(
        str(checkpoint_path)
    )

    mlflow.log_artifact(
        str(MANIFEST_PATH)
    )

    mlflow.log_artifact(
        str(OUTPUT / "summary.json")
    )

    print("Best stair IoU:", best_iou)
    print("Saved model:", checkpoint_path)
    print("MLflow run:", run.info.run_id)

# COMMAND ----------

import torch

print("CUDA available:", torch.cuda.is_available())
print("Device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")

# COMMAND ----------

# MAGIC %pip install transformers pillow matplotlib

# COMMAND ----------

import torch

print("PyTorch:", torch.__version__)
print("CUDA build:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())
print("GPU count:", torch.cuda.device_count())
print("Device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")

# COMMAND ----------

import json
import random
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path("/Volumes/workspace/default/stair_sample")
OUTPUT = ROOT / "prepared_stairs_v2"
MANIFEST_PATH = OUTPUT / "manifest.jsonl"
TRAIN_COUNT = 1800
VALIDATION_COUNT = 400
SEED = 42

zip_files = sorted(
    ROOT.glob("*.zip"),
    key=lambda path: path.stat().st_size,
    reverse=True
)

if not zip_files:
    raise FileNotFoundError(f"No ZIP found in {ROOT}")

ZIP_PATH = zip_files[0]

with zipfile.ZipFile(ZIP_PATH) as archive:
    members = [
        name
        for name in archive.namelist()
        if not name.endswith("/")
    ]

def normalize_stem(filename):
    stem = PurePosixPath(filename).stem.lower()

    stem = re.sub(
        r"^(rgb|image|images|depth|depthes|segmentation|segmentations|mask|masks)[\s_-]*",
        "",
        stem
    )

    return re.sub(
        r"[^a-z0-9]+",
        "_",
        stem
    ).strip("_")

def index_folder(split, folder):
    indexed = {}

    for name in members:
        path = PurePosixPath(name)
        parts = list(path.parts)
        lower_parts = [
            part.lower()
            for part in parts
        ]

        try:
            split_position = lower_parts.index(split)
            folder_position = lower_parts.index(
                folder,
                split_position + 1
            )
        except ValueError:
            continue

        if folder_position != split_position + 1:
            continue

        nested_parts = [
            part.lower()
            for part in parts[
                folder_position + 1:-1
            ]
        ]

        stem = normalize_stem(name)

        if not stem:
            continue

        key_parts = nested_parts + [stem]
        key = "/".join(key_parts)

        indexed[key] = name

    return indexed

train_rgb = index_folder("train", "images")
train_depth = index_folder("train", "depthes")
train_mask = index_folder(
    "train",
    "segmentations"
)

validation_rgb = index_folder("val", "images")
validation_depth = index_folder("val", "depthes")
validation_mask = index_folder(
    "val",
    "segmentations"
)

train_ids = sorted(
    set(train_rgb)
    & set(train_depth)
    & set(train_mask)
)

validation_ids = sorted(
    set(validation_rgb)
    & set(validation_depth)
    & set(validation_mask)
)

print({
    "train_rgb": len(train_rgb),
    "train_depth": len(train_depth),
    "train_masks": len(train_mask),
    "matched_train": len(train_ids),
    "validation_rgb": len(validation_rgb),
    "validation_depth": len(validation_depth),
    "validation_masks": len(validation_mask),
    "matched_validation": len(validation_ids)
})

random_generator = random.Random(SEED)
random_generator.shuffle(train_ids)
random_generator.shuffle(validation_ids)

train_ids = train_ids[:TRAIN_COUNT]
validation_ids = validation_ids[:VALIDATION_COUNT]

if len(train_ids) < TRAIN_COUNT:
    raise ValueError(
        f"Only {len(train_ids)} official training examples found"
    )

if len(validation_ids) < VALIDATION_COUNT:
    raise ValueError(
        f"Only {len(validation_ids)} official validation examples found"
    )

def extract_split(
    archive,
    split_name,
    sample_ids,
    rgb_index,
    depth_index,
    mask_index
):
    split_rows = []

    for output_id, sample_id in enumerate(sample_ids):
        sources = {
            "rgb": rgb_index[sample_id],
            "depth": depth_index[sample_id],
            "mask": mask_index[sample_id]
        }

        row = {
            "split": split_name,
            "sample_id": sample_id
        }

        for modality, source_name in sources.items():
            extension = PurePosixPath(
                source_name
            ).suffix.lower()

            destination = (
                OUTPUT
                / split_name
                / modality
                / f"{output_id:05d}{extension}"
            )

            destination.parent.mkdir(
                parents=True,
                exist_ok=True
            )

            with archive.open(source_name) as source:
                with destination.open("wb") as target:
                    shutil.copyfileobj(
                        source,
                        target
                    )

            row[modality] = str(destination)

        split_rows.append(row)

    return split_rows

rows = []

with zipfile.ZipFile(ZIP_PATH) as archive:
    rows.extend(
        extract_split(
            archive,
            "train",
            train_ids,
            train_rgb,
            train_depth,
            train_mask
        )
    )

    rows.extend(
        extract_split(
            archive,
            "validation",
            validation_ids,
            validation_rgb,
            validation_depth,
            validation_mask
        )
    )

OUTPUT.mkdir(
    parents=True,
    exist_ok=True
)

with MANIFEST_PATH.open(
    "w",
    encoding="utf-8"
) as manifest:
    for row in rows:
        manifest.write(
            json.dumps(row) + "\n"
        )

summary = {
    "zip": str(ZIP_PATH),
    "official_train_matches": len(
        set(train_rgb)
        & set(train_depth)
        & set(train_mask)
    ),
    "official_validation_matches": len(
        set(validation_rgb)
        & set(validation_depth)
        & set(validation_mask)
    ),
    "selected_training_examples": len(train_ids),
    "selected_validation_examples": len(validation_ids),
    "manifest": str(MANIFEST_PATH)
}

(OUTPUT / "summary.json").write_text(
    json.dumps(summary, indent=2),
    encoding="utf-8"
)

print(json.dumps(summary, indent=2))

# COMMAND ----------

import gc
import json
import mlflow
import numpy as np
import random
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision
from PIL import Image, ImageEnhance
from torch.utils.data import DataLoader, Dataset
from torchvision.models.segmentation import (
    DeepLabV3_ResNet50_Weights,
    deeplabv3_resnet50
)

IMAGE_SIZE = 384
BATCH_SIZE = 8
EPOCHS = 20
LEARNING_RATE = 0.0003
NUM_CLASSES = 3
DEVICE = torch.device(
    "cuda" if torch.cuda.is_available() else "cpu"
)

if DEVICE.type != "cuda":
    raise RuntimeError("The notebook is not connected to the GPU broooooooooo")

torch.manual_seed(42)
np.random.seed(42)
random.seed(42)
torch.cuda.manual_seed_all(42)
torch.backends.cudnn.benchmark = True

gc.collect()
torch.cuda.empty_cache()

class StairDataset(Dataset):
    def __init__(self, manifest_path, split, augment=False):
        rows = [
            json.loads(line)
            for line in Path(manifest_path).read_text().splitlines()
            if line.strip()
        ]

        self.rows = [
            row
            for row in rows
            if row["split"] == split
        ]

        self.augment = augment

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]

        rgb_image = Image.open(row["rgb"]).convert("RGB")

        depth_array = np.asarray(
            Image.open(row["depth"]),
            dtype=np.float32
        )

        mask_array = np.asarray(
            Image.open(row["mask"])
        )

        if depth_array.ndim == 3:
            depth_array = depth_array[:, :, 0]

        if mask_array.ndim == 3:
            mask_array = mask_array[:, :, 0]

        if self.augment and random.random() < 0.5:
            rgb_image = rgb_image.transpose(
                Image.Transpose.FLIP_LEFT_RIGHT
            )
            depth_array = np.fliplr(depth_array).copy()
            mask_array = np.fliplr(mask_array).copy()

        if self.augment:
            brightness = random.uniform(0.8, 1.2)
            contrast = random.uniform(0.8, 1.2)

            rgb_image = ImageEnhance.Brightness(
                rgb_image
            ).enhance(brightness)

            rgb_image = ImageEnhance.Contrast(
                rgb_image
            ).enhance(contrast)

        rgb_image = rgb_image.resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.BILINEAR
        )

        depth_image = Image.fromarray(
            depth_array.astype(np.float32),
            mode="F"
        ).resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.BILINEAR
        )

        mask_image = Image.fromarray(
            mask_array
        ).resize(
            (IMAGE_SIZE, IMAGE_SIZE),
            Image.Resampling.NEAREST
        )

        rgb = np.asarray(
            rgb_image,
            dtype=np.float32
        ) / 255.0

        depth = np.asarray(
            depth_image,
            dtype=np.float32
        )

        mask = np.asarray(mask_image)

        valid_depth = depth[
            np.isfinite(depth) & (depth > 0)
        ]

        if valid_depth.size:
            low, high = np.percentile(
                valid_depth,
                [1, 99]
            )

            depth = np.clip(depth, low, high)
            depth = (
                (depth - low)
                / max(high - low, 1e-6)
            )
            depth = np.nan_to_num(depth)
        else:
            depth = np.zeros_like(depth)

        target = np.zeros(
            mask.shape,
            dtype=np.int64
        )

        target[
            (mask > 0) & (mask < 192)
        ] = 1

        target[mask >= 192] = 2

        rgb_mean = np.array(
            [0.485, 0.456, 0.406],
            dtype=np.float32
        )

        rgb_std = np.array(
            [0.229, 0.224, 0.225],
            dtype=np.float32
        )

        rgb = (rgb - rgb_mean) / rgb_std
        depth = (depth - 0.5) / 0.25

        image = np.concatenate(
            [rgb, depth[:, :, None]],
            axis=2
        )

        image = torch.from_numpy(
            image.transpose(2, 0, 1)
        ).float()

        target = torch.from_numpy(
            target
        ).long()

        return image, target

train_dataset = StairDataset(
    MANIFEST_PATH,
    "train",
    augment=True
)

validation_dataset = StairDataset(
    MANIFEST_PATH,
    "validation",
    augment=False
)

train_loader = DataLoader(
    train_dataset,
    batch_size=BATCH_SIZE,
    shuffle=True,
    num_workers=2,
    pin_memory=True,
    persistent_workers=True
)

validation_loader = DataLoader(
    validation_dataset,
    batch_size=BATCH_SIZE,
    shuffle=False,
    num_workers=2,
    pin_memory=True,
    persistent_workers=True
)

weights = DeepLabV3_ResNet50_Weights.DEFAULT

model = deeplabv3_resnet50(
    weights=weights
)

old_convolution = model.backbone.conv1

new_convolution = nn.Conv2d(
    4,
    old_convolution.out_channels,
    kernel_size=old_convolution.kernel_size,
    stride=old_convolution.stride,
    padding=old_convolution.padding,
    bias=False
)

with torch.no_grad():
    new_convolution.weight[:, :3] = (
        old_convolution.weight
    )

    new_convolution.weight[:, 3:4] = (
        old_convolution.weight.mean(
            dim=1,
            keepdim=True
        )
    )

model.backbone.conv1 = new_convolution

model.classifier[-1] = nn.Conv2d(
    256,
    NUM_CLASSES,
    kernel_size=1
)

if model.aux_classifier is not None:
    model.aux_classifier[-1] = nn.Conv2d(
        256,
        NUM_CLASSES,
        kernel_size=1
    )

model = model.to(DEVICE)

class CombinedLoss(nn.Module):
    def __init__(self):
        super().__init__()

        class_weights = torch.tensor(
            [0.4, 1.3, 1.0],
            dtype=torch.float32
        )

        self.cross_entropy = nn.CrossEntropyLoss(
            weight=class_weights.to(DEVICE)
        )

    def forward(self, logits, targets):
        cross_entropy_loss = self.cross_entropy(
            logits,
            targets
        )

        probabilities = torch.softmax(
            logits,
            dim=1
        )

        one_hot = F.one_hot(
            targets,
            NUM_CLASSES
        ).permute(0, 3, 1, 2).float()

        foreground_probabilities = probabilities[:, 1:]
        foreground_targets = one_hot[:, 1:]

        intersection = (
            foreground_probabilities
            * foreground_targets
        ).sum(dim=(0, 2, 3))

        denominator = (
            foreground_probabilities
            + foreground_targets
        ).sum(dim=(0, 2, 3))

        dice = (
            (2.0 * intersection + 1.0)
            / (denominator + 1.0)
        )

        dice_loss = 1.0 - dice.mean()

        return cross_entropy_loss + 0.7 * dice_loss

criterion = CombinedLoss()

optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=LEARNING_RATE,
    weight_decay=0.0001
)

scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
    optimizer,
    T_max=EPOCHS
)

scaler = torch.amp.GradScaler(
    "cuda",
    enabled=True
)

def evaluate_model(model, loader):
    model.eval()

    confusion = torch.zeros(
        NUM_CLASSES,
        NUM_CLASSES,
        dtype=torch.int64
    )

    total_loss = 0.0

    with torch.no_grad():
        for images, targets in loader:
            images = images.to(
                DEVICE,
                non_blocking=True
            )

            targets = targets.to(
                DEVICE,
                non_blocking=True
            )

            with torch.amp.autocast(
                "cuda",
                enabled=True
            ):
                logits = model(images)["out"]
                loss = criterion(logits, targets)

            total_loss += loss.item()

            predictions = logits.argmax(dim=1)

            values = (
                targets.view(-1) * NUM_CLASSES
                + predictions.view(-1)
            )

            batch_confusion = torch.bincount(
                values,
                minlength=NUM_CLASSES ** 2
            ).reshape(
                NUM_CLASSES,
                NUM_CLASSES
            )

            confusion += batch_confusion.cpu()

    true_positive = confusion.diag().float()
    false_positive = (
        confusion.sum(dim=0).float()
        - true_positive
    )
    false_negative = (
        confusion.sum(dim=1).float()
        - true_positive
    )

    iou = true_positive / (
        true_positive
        + false_positive
        + false_negative
    ).clamp_min(1.0)

    pixel_accuracy = (
        true_positive.sum()
        / confusion.sum().clamp_min(1)
    ).item()

    return {
        "loss": total_loss / max(len(loader), 1),
        "background_iou": iou[0].item(),
        "riser_iou": iou[1].item(),
        "tread_iou": iou[2].item(),
        "foreground_mean_iou": iou[1:].mean().item(),
        "mean_iou": iou.mean().item(),
        "pixel_accuracy": pixel_accuracy
    }

checkpoint_path = (
    OUTPUT / "best_rgbd_deeplabv3_stairs.pt"
)

best_foreground_iou = -1.0

mlflow.end_run()

with mlflow.start_run() as run:
    mlflow.log_params({
        "model": "DeepLabV3-ResNet50",
        "pretrained": True,
        "input_channels": 4,
        "classes": NUM_CLASSES,
        "image_size": IMAGE_SIZE,
        "batch_size": BATCH_SIZE,
        "epochs": EPOCHS,
        "learning_rate": LEARNING_RATE,
        "training_examples": len(train_dataset),
        "validation_examples": len(validation_dataset),
        "device": torch.cuda.get_device_name(0)
    })

    for epoch in range(1, EPOCHS + 1):
        model.train()
        total_training_loss = 0.0

        for images, targets in train_loader:
            images = images.to(
                DEVICE,
                non_blocking=True
            )

            targets = targets.to(
                DEVICE,
                non_blocking=True
            )

            optimizer.zero_grad(set_to_none=True)

            with torch.amp.autocast(
                "cuda",
                enabled=True
            ):
                logits = model(images)["out"]
                loss = criterion(logits, targets)

            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

            total_training_loss += loss.item()

        scheduler.step()

        training_loss = (
            total_training_loss
            / max(len(train_loader), 1)
        )

        validation_metrics = evaluate_model(
            model,
            validation_loader
        )

        metrics = {
            "training_loss": training_loss,
            "validation_loss": validation_metrics["loss"],
            "background_iou": validation_metrics["background_iou"],
            "riser_iou": validation_metrics["riser_iou"],
            "tread_iou": validation_metrics["tread_iou"],
            "foreground_mean_iou": validation_metrics[
                "foreground_mean_iou"
            ],
            "mean_iou": validation_metrics["mean_iou"],
            "pixel_accuracy": validation_metrics[
                "pixel_accuracy"
            ],
            "learning_rate": scheduler.get_last_lr()[0]
        }

        mlflow.log_metrics(
            metrics,
            step=epoch
        )

        if (
            validation_metrics["foreground_mean_iou"]
            > best_foreground_iou
        ):
            best_foreground_iou = validation_metrics[
                "foreground_mean_iou"
            ]

            torch.save({
                "model_state_dict": model.state_dict(),
                "epoch": epoch,
                "foreground_mean_iou": best_foreground_iou,
                "image_size": IMAGE_SIZE,
                "classes": {
                    0: "background",
                    1: "riser",
                    2: "tread"
                }
            }, checkpoint_path)

        print({
            "epoch": epoch,
            "training_loss": round(
                training_loss,
                4
            ),
            "validation_loss": round(
                validation_metrics["loss"],
                4
            ),
            "riser_iou": round(
                validation_metrics["riser_iou"],
                4
            ),
            "tread_iou": round(
                validation_metrics["tread_iou"],
                4
            ),
            "foreground_mean_iou": round(
                validation_metrics["foreground_mean_iou"],
                4
            ),
            "pixel_accuracy": round(
                validation_metrics["pixel_accuracy"],
                4
            )
        })

    mlflow.log_metric(
        "best_foreground_mean_iou",
        best_foreground_iou
    )

    mlflow.log_artifact(
        str(checkpoint_path)
    )

    mlflow.log_artifact(
        str(MANIFEST_PATH)
    )

    mlflow.log_artifact(
        str(OUTPUT / "summary.json")
    )

    print("Best foreground IoU:", best_foreground_iou)
    print("Saved model:", checkpoint_path)
    print("MLflow run:", run.info.run_id)