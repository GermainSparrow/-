const crypto = require("node:crypto");
const fs = require("node:fs");
const { AppError } = require("./app-error");

const FORMAT_VERSION = 1;
const ALGORITHM = "AES-256-GCM";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

function toBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

function fromBase64(value) {
  return Buffer.from(value, "base64");
}

function aesGcmEncrypt(key, plaintext, aad = "") {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  if (aad) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: toBase64(iv),
    tag: toBase64(tag),
    ciphertext: toBase64(encrypted)
  };
}

function aesGcmDecrypt(key, payload, aad = "") {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromBase64(payload.iv), {
      authTagLength: TAG_LENGTH
    });
    if (aad) {
      decipher.setAAD(Buffer.from(aad, "utf8"));
    }
    decipher.setAuthTag(fromBase64(payload.tag));
    return Buffer.concat([decipher.update(fromBase64(payload.ciphertext)), decipher.final()]);
  } catch (error) {
    throw new AppError("DECRYPT_FAILED", "解密失败，请检查口令、密钥文件或映射文件", null);
  }
}

function derivePasswordKey(password, salt, params = SCRYPT_PARAMS) {
  return crypto.scryptSync(password, salt, KEY_LENGTH, params);
}

function deriveKeyFileKey(keyFilePath) {
  const keyFileBytes = fs.readFileSync(keyFilePath);
  return crypto.createHash("sha256").update(keyFileBytes).digest();
}

function createWrappingKey(credential) {
  if (credential.method === "password") {
    const salt = crypto.randomBytes(16);
    return {
      key: derivePasswordKey(credential.password, salt),
      descriptor: {
        method: "password",
        kdf: {
          name: "scrypt",
          params: SCRYPT_PARAMS,
          salt: toBase64(salt)
        }
      }
    };
  }

  return {
    key: deriveKeyFileKey(credential.keyFilePath),
    descriptor: {
      method: "keyFile",
      kdf: {
        name: "sha256"
      }
    }
  };
}

function createUnwrappingKey(mappingPackage, credential) {
  if (mappingPackage.wrap.method !== credential.method) {
    throw new AppError("CREDENTIAL_METHOD_MISMATCH", "映射文件的解锁方式与当前选择不一致", {
      expected: mappingPackage.wrap.method,
      actual: credential.method
    });
  }

  if (credential.method === "password") {
    const kdf = mappingPackage.wrap.kdf;
    return derivePasswordKey(credential.password, fromBase64(kdf.salt), kdf.params);
  }

  return deriveKeyFileKey(credential.keyFilePath);
}

function createEncryptedMapping({ docId, sourceFileName, entities, credential }) {
  const dek = crypto.randomBytes(KEY_LENGTH);
  const { key: wrappingKey, descriptor } = createWrappingKey(credential);
  const createdAt = new Date().toISOString();
  const aad = `${docId}:${createdAt}`;

  const mappingPayload = {
    version: FORMAT_VERSION,
    docId,
    sourceFileName,
    createdAt,
    entities: entities.filter((entity) => entity.enabled !== false)
  };

  return {
    version: FORMAT_VERSION,
    docId,
    createdAt,
    algorithm: ALGORITHM,
    wrap: descriptor,
    wrappedDek: aesGcmEncrypt(wrappingKey, dek, aad),
    encryptedMapping: aesGcmEncrypt(dek, Buffer.from(JSON.stringify(mappingPayload), "utf8"), aad)
  };
}

function decryptMappingPackage(mappingPackage, credential) {
  if (!mappingPackage || mappingPackage.version !== FORMAT_VERSION) {
    throw new AppError("UNSUPPORTED_MAPPING", "不支持的映射文件版本", {
      version: mappingPackage?.version
    });
  }

  const aad = `${mappingPackage.docId}:${mappingPackage.createdAt}`;
  const wrappingKey = createUnwrappingKey(mappingPackage, credential);
  const dek = aesGcmDecrypt(wrappingKey, mappingPackage.wrappedDek, aad);
  const payload = aesGcmDecrypt(dek, mappingPackage.encryptedMapping, aad);
  return JSON.parse(payload.toString("utf8"));
}

module.exports = {
  ALGORITHM,
  createEncryptedMapping,
  decryptMappingPackage
};
