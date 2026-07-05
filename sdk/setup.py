from setuptools import setup, find_packages

setup(
    name="iye-sdk",
    version="1.0.0",
    description="Python SDK for the IYE 3D structural data anomaly engine",
    author="IYE Core Infrastructure Team",
    packages=find_packages(),
    install_requires=[
        "numpy>=1.26.0",
        "scipy>=1.12.0",
        "umap-learn>=0.5.5",
        "hdbscan>=0.8.33",
        "requests>=2.31.0",
        "pydantic>=2.6.0"
    ],
    python_requires=">=3.9",
)
