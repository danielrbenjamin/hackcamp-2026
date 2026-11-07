"""Export a reviewed MLflow model on the Mac and compare Core ML to PyTorch."""
import argparse

import coremltools as ct
import mlflow.pytorch
import numpy as np
import torch


def export(uri, version, output):
    model = mlflow.pytorch.load_model(uri, map_location="cpu").eval()
    example = torch.zeros((1, 1, 20, 40), dtype=torch.float32)
    traced = torch.jit.trace(model, example)
    converted = ct.convert(traced, convert_to="mlprogram",
                           inputs=[ct.TensorType(name="bev", shape=example.shape)],
                           outputs=[ct.TensorType(name="scores")],
                           minimum_deployment_target=ct.target.iOS17)
    converted.version = version
    rng = np.random.default_rng(42)
    for _ in range(8):
        grid = rng.integers(0, 3, size=example.shape).astype(np.float32) / 2
        with torch.no_grad():
            expected = model(torch.from_numpy(grid)).numpy()
        actual = converted.predict({"bev": grid})["scores"]
        np.testing.assert_allclose(actual, expected, atol=0.01, rtol=0.01)
    converted.save(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("model_uri")
    parser.add_argument("version")
    parser.add_argument("--output", default="Traversability.mlpackage")
    args = parser.parse_args()
    export(args.model_uri, args.version, args.output)
