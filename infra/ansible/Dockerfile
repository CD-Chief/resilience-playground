FROM python:3.12.16-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client rsync \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir ansible-core==2.21.6

COPY requirements.yml /tmp/requirements.yml
RUN ansible-galaxy collection install -r /tmp/requirements.yml -p /usr/share/ansible/collections \
    && rm /tmp/requirements.yml

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The repo is mounted at /work; an explicit path is used because Ansible
# ignores an ansible.cfg that sits in a world-writable directory (Windows mounts).
ENV ANSIBLE_CONFIG=/work/infra/ansible/ansible.cfg
WORKDIR /work/infra/ansible
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
