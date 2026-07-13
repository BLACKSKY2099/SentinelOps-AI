FROM python:3.11-slim

WORKDIR /workspace

# Install AWS CLI and basic tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

# Copy requirements file (if empty, we install explicitly too)
COPY requirements.txt .

# Install dependencies (ensure boto3 and pytest are present for agents & tests)
RUN pip install --no-cache-dir -r requirements.txt \
    || pip install --no-cache-dir boto3 botocore pytest

# Copy all source files
COPY . .

# Set python path
ENV PYTHONPATH=/workspace

# Set default command to run tests, can be overridden in docker-compose or run commands
CMD ["python", "-m", "unittest", "discover", "-s", "tests"]
