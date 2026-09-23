import { Module } from '@nestjs/common';
import { AttachmentStorageService } from './attachment-storage.service.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';

@Module({
  controllers: [MessagesController],
  providers: [MessagesService, AttachmentStorageService],
})
export class MessagesModule {}
