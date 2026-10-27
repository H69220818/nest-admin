import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddMemberDomain1793080800000 implements MigrationInterface {
  name = 'AddMemberDomain1793080800000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`member\` (
      \`id\` int UNSIGNED NOT NULL AUTO_INCREMENT,
      \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      \`parent_id\` int UNSIGNED NULL,
      \`invite_code\` varchar(16) NOT NULL,
      \`phone\` varchar(32) NOT NULL,
      \`phone_verified_at\` datetime NOT NULL,
      \`email\` varchar(255) NULL,
      \`nickname\` varchar(64) NULL,
      \`avatar\` varchar(500) NULL,
      \`status\` tinyint NOT NULL DEFAULT 1,
      UNIQUE INDEX \`UQ_member_phone\` (\`phone\`),
      UNIQUE INDEX \`UQ_member_invite_code\` (\`invite_code\`),
      INDEX \`IDX_member_parent_id\` (\`parent_id\`),
      PRIMARY KEY (\`id\`),
      CONSTRAINT \`FK_member_parent\` FOREIGN KEY (\`parent_id\`) REFERENCES \`member\` (\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await queryRunner.query(`CREATE TABLE \`member_identity\` (
      \`id\` int UNSIGNED NOT NULL AUTO_INCREMENT,
      \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      \`member_id\` int UNSIGNED NOT NULL,
      \`provider\` varchar(32) NOT NULL,
      \`provider_tenant\` varchar(128) COLLATE utf8mb4_bin NOT NULL,
      \`provider_subject\` varchar(191) COLLATE utf8mb4_bin NOT NULL,
      \`union_id\` varchar(191) COLLATE utf8mb4_bin NULL,
      \`display_name\` varchar(64) NULL,
      \`avatar\` varchar(500) NULL,
      UNIQUE INDEX \`UQ_member_identity_subject\` (\`provider\`, \`provider_tenant\`, \`provider_subject\`),
      UNIQUE INDEX \`UQ_member_identity_binding\` (\`member_id\`, \`provider\`, \`provider_tenant\`),
      PRIMARY KEY (\`id\`),
      CONSTRAINT \`FK_member_identity_member\` FOREIGN KEY (\`member_id\`) REFERENCES \`member\` (\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await queryRunner.query(`CREATE TABLE \`member_access_token\` (
      \`id\` varchar(36) NOT NULL,
      \`member_id\` int UNSIGNED NOT NULL,
      \`token_hash\` varchar(64) NOT NULL,
      \`expires_at\` datetime NOT NULL,
      \`revoked_at\` datetime NULL,
      \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE INDEX \`UQ_member_access_token_hash\` (\`token_hash\`),
      INDEX \`IDX_member_access_token_member_id\` (\`member_id\`),
      PRIMARY KEY (\`id\`),
      CONSTRAINT \`FK_member_access_token_member\` FOREIGN KEY (\`member_id\`) REFERENCES \`member\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await queryRunner.query(`CREATE TABLE \`member_refresh_token\` (
      \`id\` varchar(36) NOT NULL,
      \`access_token_id\` varchar(36) NOT NULL,
      \`family_id\` varchar(36) NOT NULL,
      \`token_hash\` varchar(64) NOT NULL,
      \`expires_at\` datetime NOT NULL,
      \`consumed_at\` datetime NULL,
      \`revoked_at\` datetime NULL,
      \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE INDEX \`UQ_member_refresh_token_hash\` (\`token_hash\`),
      INDEX \`IDX_member_refresh_token_access_token_id\` (\`access_token_id\`),
      INDEX \`IDX_member_refresh_token_family_id\` (\`family_id\`),
      PRIMARY KEY (\`id\`),
      CONSTRAINT \`FK_member_refresh_token_access_token\` FOREIGN KEY (\`access_token_id\`) REFERENCES \`member_access_token\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `member_refresh_token`')
    await queryRunner.query('DROP TABLE `member_access_token`')
    await queryRunner.query('DROP TABLE `member_identity`')
    await queryRunner.query('DROP TABLE `member`')
  }
}
