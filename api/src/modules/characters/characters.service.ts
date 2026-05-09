import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../../common/app-error.exception';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { CharacterEntity } from './character.entity';
import { PersonalityProfile } from '../ai/ai.types';
import { applyPersistentNaturalDialogueProfile } from '../ai/prompt-naturalness';
import { ConversationEntity } from '../chat/conversation.entity';
import { MessageEntity } from '../chat/message.entity';
import { GroupEntity } from '../chat/group.entity';
import { GroupMemberEntity } from '../chat/group-member.entity';
import { GroupMessageEntity } from '../chat/group-message.entity';
import { FriendshipEntity } from '../social/friendship.entity';
import { FriendRequestEntity } from '../social/friend-request.entity';
import { AIRelationshipEntity } from '../social/ai-relationship.entity';
import { NarrativeArcEntity } from '../narrative/narrative-arc.entity';
import { CharacterBlueprintEntity } from './character-blueprint.entity';
import { CharacterBlueprintRevisionEntity } from './character-blueprint-revision.entity';
import { MomentPostEntity } from '../moments/moment-post.entity';
import { MomentCommentEntity } from '../moments/moment-comment.entity';
import { MomentLikeEntity } from '../moments/moment-like.entity';
import { FeedPostEntity } from '../feed/feed-post.entity';
import { FeedCommentEntity } from '../feed/feed-comment.entity';
import { VideoChannelFollowEntity } from '../feed/video-channel-follow.entity';
import { UserFeedInteractionEntity } from '../analytics/user-feed-interaction.entity';
import { AIBehaviorLogEntity } from '../analytics/ai-behavior-log.entity';
import { ModerationReportEntity } from '../moderation/moderation-report.entity';
import { WorldOwnerService } from '../auth/world-owner.service';
import { NeedDiscoveryCandidateEntity } from '../need-discovery/need-discovery-candidate.entity';
import { RealWorldRuntimeProfileService } from '../real-world-sync/real-world-runtime-profile.service';
import {
  // i18n-ignore-start: data / seed / preset content — not user-facing UI.
  buildDefaultCharacters,
  DEFAULT_CHARACTER_IDS,
} from './default-characters';
import { getCelebrityCharacterPresetGroup } from './celebrity-character-presets';
import {
  BUILT_IN_CHARACTER_PRESETS,
  getBuiltInCharacterPreset,
} from './built-in-character-presets';
import { maybeGetCharacterAvatarBySourceKey } from './character-avatar-assets';

export type Character = CharacterEntity;
export type OwnerCharacterCreateInput = Partial<CharacterEntity>;
export type OwnerCharacterUpdateInput = Partial<CharacterEntity>;

@Injectable()
export class CharactersService implements OnModuleInit {
  constructor(
    @InjectRepository(CharacterEntity)
    private repo: Repository<CharacterEntity>,
    @InjectRepository(FriendshipEntity)
    private readonly friendshipRepo: Repository<FriendshipEntity>,
    private readonly worldOwnerService: WorldOwnerService,
    private readonly dataSource: DataSource,
    private readonly realWorldRuntimeProfile: RealWorldRuntimeProfileService,
  ) {}

  async onModuleInit() {
    await this.backfillCharacterAvatarAssets();
  }

  async findAll(): Promise<CharacterEntity[]> {
    const characters = await this.repo.find({ order: { name: 'ASC' } });
    return this.normalizeCharacterAvatars(characters);
  }

  async findById(id: string): Promise<CharacterEntity | null> {
    const character = await this.repo.findOneBy({ id });
    return this.normalizeCharacterAvatar(character);
  }

  async findAllVisibleToOwner(ownerId?: string): Promise<CharacterEntity[]> {
    const characters = await this.findAll();
    return this.filterNeedGeneratedVisibility(characters, ownerId);
  }

  async isVisibleToOwner(
    characterId: string,
    ownerId?: string,
  ): Promise<boolean> {
    const character = await this.findById(characterId);
    if (!character) {
      return false;
    }

    if (character.sourceType !== 'need_generated') {
      return true;
    }

    const activeFriendCharacterIds =
      await this.getActiveFriendCharacterIdSet(ownerId);
    return activeFriendCharacterIds.has(characterId);
  }

  async findByDomains(domains: string[]): Promise<CharacterEntity[]> {
    const all = await this.findAll();
    return all.filter((c) => c.expertDomains.some((d) => domains.includes(d)));
  }

  async getProfile(id: string): Promise<PersonalityProfile | undefined> {
    const char = await this.repo.findOneBy({ id });
    return this.getRuntimeProfileFromCharacter(char);
  }

  async getRuntimeProfileFromCharacter(
    character: Pick<CharacterEntity, 'id' | 'profile'> | null | undefined,
  ): Promise<PersonalityProfile | undefined> {
    return this.realWorldRuntimeProfile.buildRuntimeProfileFromCharacter(
      character,
    );
  }

  async upsert(character: CharacterEntity): Promise<void> {
    await this.repo.save(character);
  }

  async createOwnerCharacter(
    input: OwnerCharacterCreateInput,
  ): Promise<CharacterEntity> {
    const id =
      this.normalizeOptionalString(input.id) ?? this.createCharacterId();
    const name = this.normalizeOptionalString(input.name) ?? 'New character';
    const relationship =
      this.normalizeOptionalString(input.relationship) ?? 'friend';
    const relationshipType =
      this.normalizeOptionalString(input.relationshipType) ?? 'friend';
    const expertDomains = this.normalizeStringArray(input.expertDomains);
    const profile = this.normalizeOwnerCharacterProfile(input.profile, {
      characterId: id,
      name,
      relationship,
      expertDomains,
    });

    const character = {
      id,
      name,
      avatar: this.normalizeOptionalString(input.avatar) ?? '',
      relationship,
      relationshipType,
      personality: this.normalizeOptionalString(input.personality),
      bio: this.normalizeOptionalString(input.bio) ?? '',
      isOnline: input.isOnline ?? false,
      onlineMode: this.normalizeOptionalString(input.onlineMode) ?? 'auto',
      sourceType: 'manual_admin',
      sourceKey: this.normalizeNullableString(input.sourceKey),
      deletionPolicy: 'archive_allowed',
      isTemplate: false,
      expertDomains,
      profile,
      activityFrequency:
        this.normalizeOptionalString(input.activityFrequency) ?? 'normal',
      momentsFrequency: this.normalizeNumber(input.momentsFrequency, 1),
      feedFrequency: this.normalizeNumber(input.feedFrequency, 1),
      activeHoursStart: this.normalizeNullableNumber(input.activeHoursStart),
      activeHoursEnd: this.normalizeNullableNumber(input.activeHoursEnd),
      triggerScenes: this.normalizeNullableStringArray(input.triggerScenes),
      intimacyLevel: this.normalizeNumber(input.intimacyLevel, 0),
      lastActiveAt: input.lastActiveAt,
      socialOpenness:
        this.normalizeOptionalString(input.socialOpenness) ?? 'normal',
      proactiveBrowseChance: this.normalizeNumber(
        input.proactiveBrowseChance,
        0.3,
      ),
      aiRelationships: input.aiRelationships,
      currentStatus: this.normalizeNullableString(input.currentStatus),
      currentActivity: this.normalizeNullableString(input.currentActivity),
      activityMode: this.normalizeOptionalString(input.activityMode) ?? 'auto',
      modelRoutingMode:
        this.normalizeOptionalString(input.modelRoutingMode) ??
        'inherit_default',
      inferenceProviderAccountId: this.normalizeNullableString(
        input.inferenceProviderAccountId,
      ),
      inferenceModelId: this.normalizeNullableString(input.inferenceModelId),
      allowOwnerKeyOverride: input.allowOwnerKeyOverride ?? true,
      modelRoutingNotes: this.normalizeNullableString(input.modelRoutingNotes),
      region: this.normalizeNullableString(input.region),
    } as CharacterEntity;

    return this.repo.save(character);
  }

  async updateOwnerCharacter(
    id: string,
    input: OwnerCharacterUpdateInput,
  ): Promise<CharacterEntity> {
    const existing = await this.requireOwnerEditableCharacter(id);
    const nextName = this.normalizeOptionalString(input.name) ?? existing.name;
    const nextRelationship =
      this.normalizeOptionalString(input.relationship) ?? existing.relationship;
    const nextExpertDomains =
      input.expertDomains === undefined
        ? existing.expertDomains
        : this.normalizeStringArray(input.expertDomains);
    const nextProfile =
      input.profile === undefined
        ? existing.profile
        : this.normalizeOwnerCharacterProfile(input.profile, {
            characterId: id,
            name: nextName,
            relationship: nextRelationship,
            expertDomains: nextExpertDomains,
          });

    const updated = {
      ...existing,
      name: nextName,
      avatar: this.normalizeOptionalString(input.avatar) ?? existing.avatar,
      relationship: nextRelationship,
      relationshipType:
        this.normalizeOptionalString(input.relationshipType) ??
        existing.relationshipType,
      personality:
        input.personality === undefined
          ? existing.personality
          : this.normalizeOptionalString(input.personality),
      bio: this.normalizeOptionalString(input.bio) ?? existing.bio,
      isOnline: input.isOnline ?? existing.isOnline,
      onlineMode:
        this.normalizeOptionalString(input.onlineMode) ?? existing.onlineMode,
      sourceType: existing.sourceType,
      sourceKey: existing.sourceKey,
      deletionPolicy: existing.deletionPolicy,
      isTemplate: existing.isTemplate,
      expertDomains: nextExpertDomains,
      profile: nextProfile,
      activityFrequency:
        this.normalizeOptionalString(input.activityFrequency) ??
        existing.activityFrequency,
      momentsFrequency:
        input.momentsFrequency === undefined
          ? existing.momentsFrequency
          : this.normalizeNumber(
              input.momentsFrequency,
              existing.momentsFrequency,
            ),
      feedFrequency:
        input.feedFrequency === undefined
          ? existing.feedFrequency
          : this.normalizeNumber(input.feedFrequency, existing.feedFrequency),
      activeHoursStart:
        input.activeHoursStart === undefined
          ? existing.activeHoursStart
          : this.normalizeNullableNumber(input.activeHoursStart),
      activeHoursEnd:
        input.activeHoursEnd === undefined
          ? existing.activeHoursEnd
          : this.normalizeNullableNumber(input.activeHoursEnd),
      triggerScenes:
        input.triggerScenes === undefined
          ? existing.triggerScenes
          : this.normalizeNullableStringArray(input.triggerScenes),
      intimacyLevel:
        input.intimacyLevel === undefined
          ? existing.intimacyLevel
          : this.normalizeNumber(input.intimacyLevel, existing.intimacyLevel),
      lastActiveAt: input.lastActiveAt ?? existing.lastActiveAt,
      socialOpenness:
        this.normalizeOptionalString(input.socialOpenness) ??
        existing.socialOpenness,
      proactiveBrowseChance:
        input.proactiveBrowseChance === undefined
          ? existing.proactiveBrowseChance
          : this.normalizeNumber(
              input.proactiveBrowseChance,
              existing.proactiveBrowseChance,
            ),
      aiRelationships: input.aiRelationships ?? existing.aiRelationships,
      currentStatus:
        input.currentStatus === undefined
          ? existing.currentStatus
          : this.normalizeNullableString(input.currentStatus),
      currentActivity:
        input.currentActivity === undefined
          ? existing.currentActivity
          : this.normalizeNullableString(input.currentActivity),
      activityMode:
        this.normalizeOptionalString(input.activityMode) ??
        existing.activityMode,
      modelRoutingMode:
        this.normalizeOptionalString(input.modelRoutingMode) ??
        existing.modelRoutingMode,
      inferenceProviderAccountId:
        input.inferenceProviderAccountId === undefined
          ? existing.inferenceProviderAccountId
          : this.normalizeNullableString(input.inferenceProviderAccountId),
      inferenceModelId:
        input.inferenceModelId === undefined
          ? existing.inferenceModelId
          : this.normalizeNullableString(input.inferenceModelId),
      allowOwnerKeyOverride:
        input.allowOwnerKeyOverride ?? existing.allowOwnerKeyOverride,
      modelRoutingNotes:
        input.modelRoutingNotes === undefined
          ? existing.modelRoutingNotes
          : this.normalizeNullableString(input.modelRoutingNotes),
      region:
        input.region === undefined
          ? existing.region
          : this.normalizeNullableString(input.region),
    } as CharacterEntity;

    return this.repo.save(updated);
  }

  async deleteOwnerCharacter(id: string): Promise<void> {
    await this.requireOwnerEditableCharacter(id);
    await this.delete(id);
  }

  /**
   * 返回世界角色目录中所有内置角色的完整数据（不查 DB）。
   * 默认保底角色和内置目录角色都会包含在内。
   */
  listPresetCatalog(): CharacterEntity[] {
    const seen = new Set<string>();
    const catalogCharacters = [
      ...buildDefaultCharacters(),
      ...BUILT_IN_CHARACTER_PRESETS.map(
        (preset) => preset.character as CharacterEntity,
      ),
    ].filter((character): character is CharacterEntity => {
      if (!character?.id || seen.has(character.id)) {
        return false;
      }

      seen.add(character.id);
      return true;
    });

    return this.normalizeCharacterAvatars(catalogCharacters);
  }

  /**
   * 确保预设角色已写入 DB。
   * - 已存在：直接返回 DB 记录（保留管理员改动）
   * - 不存在但匹配预设：从硬编码安装后返回
   * - 不是预设角色：返回 null（自定义角色应已在 DB）
   */
  async ensurePresetCharacterInstalled(
    characterId: string,
  ): Promise<CharacterEntity | null> {
    const existing = await this.repo.findOneBy({ id: characterId });
    if (existing) return this.normalizeCharacterAvatar(existing);

    const preset = BUILT_IN_CHARACTER_PRESETS.find((p) => p.id === characterId);
    if (!preset) return null;

    return this.materializePresetCharacter(preset);
  }

  async listCelebrityPresets() {
    const installedCharacters = await this.repo.find({
      where: { sourceType: 'preset_catalog' },
    });
    const installedBySourceKey = new Map(
      installedCharacters
        .filter((character) => character.sourceKey)
        .map((character) => [
          character.sourceKey as string,
          { id: character.id, name: character.name },
        ]),
    );

    return BUILT_IN_CHARACTER_PRESETS.map((preset) => {
      const group = getCelebrityCharacterPresetGroup(preset.groupKey);
      const installedCharacter = installedBySourceKey.get(preset.presetKey);
      return {
        presetKey: preset.presetKey,
        groupKey: group.key,
        autoSeed: preset.autoSeed !== false,
        groupLabel: group.label,
        groupDescription: group.description,
        groupOrder: group.sortOrder,
        id: preset.id,
        name: preset.name,
        avatar: preset.avatar,
        relationship: preset.relationship,
        description: preset.description,
        expertDomains: preset.expertDomains,
        installed: Boolean(installedCharacter),
        installedCharacterId: installedCharacter?.id ?? null,
        installedCharacterName: installedCharacter?.name ?? null,
      };
    });
  }

  async installCelebrityPreset(presetKey: string): Promise<CharacterEntity> {
    const preset = getBuiltInCharacterPreset(presetKey);
    if (!preset) {
      throw new AppError('PRESET_NOT_FOUND', {
        status: HttpStatus.NOT_FOUND,
        params: { presetKey },
        legacyMessage: `Preset ${presetKey} not found`,
      });
    }

    return this.materializePresetCharacter(preset);
  }

  private async materializePresetCharacter(
    preset: NonNullable<ReturnType<typeof getBuiltInCharacterPreset>>,
  ): Promise<CharacterEntity> {
    const existing = await this.repo.findOne({
      where: [
        { id: preset.id },
        { sourceType: 'preset_catalog', sourceKey: preset.presetKey },
      ],
    });
    if (existing) {
      return this.normalizeCharacterAvatar(existing) ?? existing;
    }

    return this.repo.save(
      this.repo.create({
        ...preset.character,
        id: preset.id,
        profile: preset.character.profile
          ? applyPersistentNaturalDialogueProfile(preset.character.profile)
          : preset.character.profile,
        sourceType: 'preset_catalog',
        sourceKey: preset.presetKey,
        deletionPolicy: 'archive_allowed',
        isTemplate: false,
      }),
    );
  }

  async installCelebrityPresetBatch(presetKeys: string[]) {
    const normalizedPresetKeys = Array.from(
      new Set(
        presetKeys
          .map((presetKey) => presetKey.trim())
          .filter((presetKey) => presetKey.length > 0),
      ),
    );
    if (normalizedPresetKeys.length === 0) {
      throw new AppError('PRESET_AT_LEAST_ONE', {
        legacyMessage: '至少选择一个预设角色。',
      });
    }

    const missingPresetKeys = normalizedPresetKeys.filter(
      (presetKey) => !getBuiltInCharacterPreset(presetKey),
    );
    if (missingPresetKeys.length > 0) {
      throw new AppError('PRESET_NOT_FOUND', {
        status: HttpStatus.NOT_FOUND,
        params: { presetKey: missingPresetKeys.join(', ') },
        legacyMessage: `Preset ${missingPresetKeys.join(', ')} not found`,
      });
    }

    const installedCharacters = await Promise.all(
      normalizedPresetKeys.map((presetKey) =>
        this.installCelebrityPreset(presetKey),
      ),
    );

    return {
      presetKeys: normalizedPresetKeys,
      installedCount: installedCharacters.length,
      installedCharacters,
    };
  }

  async delete(id: string): Promise<void> {
    const character = await this.repo.findOneBy({ id });
    if (!character) {
      return;
    }

    if (
      character.deletionPolicy === 'protected' ||
      (DEFAULT_CHARACTER_IDS as readonly string[]).includes(id)
    ) {
      throw new AppError('CHARACTER_DEFAULT_NOT_DELETABLE', {
        legacyMessage: '默认保底角色不可删除。',
      });
    }

    await this.dataSource.transaction(async (manager) => {
      const conversationRepo = manager.getRepository(ConversationEntity);
      const messageRepo = manager.getRepository(MessageEntity);
      const groupRepo = manager.getRepository(GroupEntity);
      const groupMemberRepo = manager.getRepository(GroupMemberEntity);
      const groupMessageRepo = manager.getRepository(GroupMessageEntity);
      const friendRequestRepo = manager.getRepository(FriendRequestEntity);
      const friendshipRepo = manager.getRepository(FriendshipEntity);
      const aiRelationshipRepo = manager.getRepository(AIRelationshipEntity);
      const narrativeArcRepo = manager.getRepository(NarrativeArcEntity);
      const blueprintRepo = manager.getRepository(CharacterBlueprintEntity);
      const blueprintRevisionRepo = manager.getRepository(
        CharacterBlueprintRevisionEntity,
      );
      const momentPostRepo = manager.getRepository(MomentPostEntity);
      const momentCommentRepo = manager.getRepository(MomentCommentEntity);
      const momentLikeRepo = manager.getRepository(MomentLikeEntity);
      const feedPostRepo = manager.getRepository(FeedPostEntity);
      const feedCommentRepo = manager.getRepository(FeedCommentEntity);
      const videoChannelFollowRepo = manager.getRepository(
        VideoChannelFollowEntity,
      );
      const feedInteractionRepo = manager.getRepository(
        UserFeedInteractionEntity,
      );
      const aiBehaviorLogRepo = manager.getRepository(AIBehaviorLogEntity);
      const moderationReportRepo = manager.getRepository(
        ModerationReportEntity,
      );
      const needDiscoveryCandidateRepo = manager.getRepository(
        NeedDiscoveryCandidateEntity,
      );
      const characterRepo = manager.getRepository(CharacterEntity);

      const directConversations = (await conversationRepo.find()).filter(
        (conversation) =>
          conversation.type !== 'group' &&
          conversation.participants.includes(id),
      );
      const directConversationIds = directConversations.map(
        (conversation) => conversation.id,
      );

      if (directConversationIds.length > 0) {
        await messageRepo.delete({
          conversationId: In(directConversationIds),
        });
        await conversationRepo.delete({ id: In(directConversationIds) });
      }

      const createdGroups = await groupRepo.find({
        where: { creatorId: id, creatorType: 'character' },
      });
      const createdGroupIds = createdGroups.map((group) => group.id);
      if (createdGroupIds.length > 0) {
        await groupMessageRepo.delete({ groupId: In(createdGroupIds) });
        await groupMemberRepo.delete({ groupId: In(createdGroupIds) });
        await groupRepo.delete({ id: In(createdGroupIds) });
      }

      await groupMessageRepo.delete({ senderId: id, senderType: 'character' });
      await groupMemberRepo.delete({ memberId: id, memberType: 'character' });

      const momentPostIds = (
        await momentPostRepo.find({
          where: { authorId: id, authorType: 'character' },
        })
      ).map((post) => post.id);

      await momentCommentRepo.delete({ authorId: id, authorType: 'character' });
      await momentLikeRepo.delete({ authorId: id, authorType: 'character' });
      if (momentPostIds.length > 0) {
        await momentCommentRepo.delete({ postId: In(momentPostIds) });
        await momentLikeRepo.delete({ postId: In(momentPostIds) });
        await momentPostRepo.delete({ id: In(momentPostIds) });
      }

      const feedPostIds = (
        await feedPostRepo.find({
          where: { authorId: id, authorType: 'character' },
        })
      ).map((post) => post.id);

      await feedCommentRepo.delete({ authorId: id, authorType: 'character' });
      if (feedPostIds.length > 0) {
        await feedCommentRepo.delete({ postId: In(feedPostIds) });
        await feedInteractionRepo.delete({ postId: In(feedPostIds) });
        await feedPostRepo.delete({ id: In(feedPostIds) });
      }

      await friendRequestRepo.delete({ characterId: id });
      await friendshipRepo.delete({ characterId: id });
      await videoChannelFollowRepo.delete({
        authorId: id,
        authorType: 'character',
      });
      await narrativeArcRepo.delete({ characterId: id });
      await aiBehaviorLogRepo.delete({ characterId: id });
      await moderationReportRepo.delete({
        targetType: 'character',
        targetId: id,
      });
      await blueprintRevisionRepo.delete({ characterId: id });
      await blueprintRepo.delete({ characterId: id });
      await aiRelationshipRepo
        .createQueryBuilder()
        .delete()
        .where('characterIdA = :id OR characterIdB = :id', { id })
        .execute();
      await needDiscoveryCandidateRepo
        .createQueryBuilder()
        .update()
        .set({
          status: 'deleted',
          deletedAt: new Date(),
        })
        .where('characterId = :id', { id })
        .andWhere('status NOT IN (:...lockedStatuses)', {
          lockedStatuses: ['declined', 'expired', 'deleted'],
        })
        .execute();
      await characterRepo.delete(id);
    });
  }

  private async requireOwnerEditableCharacter(
    id: string,
  ): Promise<CharacterEntity> {
    const character = await this.findById(id);
    if (!character) {
      throw new AppError('CHARACTER_NOT_FOUND', {
        status: HttpStatus.NOT_FOUND,
        params: { id },
        legacyMessage: `Character ${id} not found`,
      });
    }

    if (character.deletionPolicy === 'protected') {
      throw new AppError('CHARACTER_PROTECTED', {
        status: HttpStatus.FORBIDDEN,
        params: { id },
        legacyMessage: `Character ${id} is protected`,
      });
    }

    return character;
  }

  private createCharacterId() {
    return `char_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private normalizeNullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private normalizeNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback;
  }

  private normalizeNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private normalizeNullableStringArray(value: unknown): string[] | null {
    return Array.isArray(value) ? this.normalizeStringArray(value) : null;
  }

  private normalizeOwnerCharacterProfile(
    profile: PersonalityProfile | undefined,
    fallback: {
      characterId: string;
      name: string;
      relationship: string;
      expertDomains: string[];
    },
  ): PersonalityProfile {
    return {
      traits: {
        speechPatterns: [],
        catchphrases: [],
        topicsOfInterest: [],
        emotionalTone: 'calm',
        responseLength: 'medium',
        emojiUsage: 'occasional',
      },
      memorySummary: '',
      ...profile,
      characterId: fallback.characterId,
      name: fallback.name,
      relationship: fallback.relationship,
      expertDomains: fallback.expertDomains,
    };
  }

  private normalizeCharacterAvatars(characters: CharacterEntity[]) {
    return characters.map(
      (character) => this.normalizeCharacterAvatar(character) ?? character,
    );
  }

  private normalizeCharacterAvatar(
    character: CharacterEntity | null | undefined,
  ): CharacterEntity | null {
    if (!character) {
      return null;
    }

    const canonicalAvatar = this.resolveCanonicalCharacterAvatar(character);
    if (
      !canonicalAvatar ||
      !this.shouldReplaceCharacterAvatar(character.avatar, canonicalAvatar)
    ) {
      return character;
    }

    return {
      ...character,
      avatar: canonicalAvatar,
    };
  }

  private resolveCanonicalCharacterAvatar(
    character: Pick<CharacterEntity, 'id' | 'sourceKey'>,
  ) {
    const mappedBySourceKey = maybeGetCharacterAvatarBySourceKey(
      character.sourceKey,
    );
    if (mappedBySourceKey) {
      return mappedBySourceKey;
    }

    const builtInPreset = BUILT_IN_CHARACTER_PRESETS.find(
      (preset) => preset.id === character.id,
    );
    const mappedByBuiltInPreset = maybeGetCharacterAvatarBySourceKey(
      builtInPreset?.character?.sourceKey ?? builtInPreset?.presetKey,
    );
    if (mappedByBuiltInPreset) {
      return mappedByBuiltInPreset;
    }

    const defaultCharacter = buildDefaultCharacters().find(
      (item) => item.id === character.id,
    );
    return (
      maybeGetCharacterAvatarBySourceKey(defaultCharacter?.sourceKey) ??
      builtInPreset?.character?.avatar?.trim() ??
      builtInPreset?.avatar?.trim() ??
      defaultCharacter?.avatar?.trim() ??
      null
    );
  }

  private shouldReplaceCharacterAvatar(
    currentAvatar: string | null | undefined,
    canonicalAvatar: string,
  ) {
    const normalizedAvatar = currentAvatar?.trim() ?? '';
    if (!normalizedAvatar) {
      return true;
    }

    if (normalizedAvatar === canonicalAvatar) {
      return false;
    }

    if (normalizedAvatar.startsWith('/api/character-assets/')) {
      return true;
    }

    return !this.isLikelyImageSource(normalizedAvatar);
  }

  private isLikelyImageSource(value: string) {
    return (
      value.startsWith('/') ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      value.startsWith('blob:') ||
      /^https?:\/\//i.test(value) ||
      /^data:image\//i.test(value) ||
      /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(value)
    );
  }

  private async backfillCharacterAvatarAssets() {
    const characters = await this.repo.find();
    const pendingUpdates: CharacterEntity[] = [];

    for (const character of characters) {
      const normalizedCharacter = this.normalizeCharacterAvatar(character);
      if (
        normalizedCharacter &&
        normalizedCharacter.avatar !== character.avatar
      ) {
        pendingUpdates.push(normalizedCharacter);
      }
    }

    if (pendingUpdates.length === 0) {
      return;
    }

    await this.repo.save(pendingUpdates);
  }

  private async filterNeedGeneratedVisibility(
    characters: CharacterEntity[],
    ownerId?: string,
  ) {
    const hasNeedGenerated = characters.some(
      (character) => character.sourceType === 'need_generated',
    );
    if (!hasNeedGenerated) {
      return characters;
    }

    const activeFriendCharacterIds =
      await this.getActiveFriendCharacterIdSet(ownerId);
    return characters.filter(
      (character) =>
        character.sourceType !== 'need_generated' ||
        activeFriendCharacterIds.has(character.id),
    );
  }

  async getActiveFriendCharacterIdSet(ownerId?: string) {
    const resolvedOwnerId =
      ownerId ?? (await this.worldOwnerService.getOwnerOrThrow()).id;
    const friendships = await this.friendshipRepo.find({
      select: ['characterId'],
      where: [
        { ownerId: resolvedOwnerId, status: 'friend' },
        { ownerId: resolvedOwnerId, status: 'close' },
        { ownerId: resolvedOwnerId, status: 'best' },
      ],
    });
    return new Set(friendships.map((item) => item.characterId));
  }
}
// i18n-ignore-end
