# Databricks notebook source
# /// script
# [tool.databricks.environment]
# environment_version = "6"
# dependencies = [
#   "transformers",
#   "torch",
#   "pillow",
#   "matplotlib",
# ]
# ///


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
# Check which files were uploaded
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