import moment from 'moment';

import NotificationStorage from '../storage/mongodb/NotificationStorage';
import UserStorage from '../storage/mongodb/UserStorage';
import ChargingStation from '../types/ChargingStation';
import { ServerAction } from '../types/Server';
import Tenant from '../types/Tenant';
import User, { UserRole } from '../types/User';
import UserNotifications, {
  AccountVerificationNotification,
  AdminAccountVerificationNotification,
  BillingAccountActivationNotification,
  BillingAccountCreationLinkNotification,
  BillingInvoiceSynchronizationFailedNotification,
  BillingNewInvoiceNotification,
  BillingUserSynchronizationFailedNotification,
  CarCatalogSynchronizationFailedNotification,
  ChargingStationRegisteredNotification,
  ChargingStationStatusErrorNotification,
  ComputeAndApplyChargingProfilesFailedNotification,
  EndOfChargeNotification,
  EndOfSessionNotification,
  EndOfSignedSessionNotification,
  EndUserErrorNotification,
  NewRegisteredUserNotification,
  NotificationSeverity,
  NotificationSource,
  OCPIPatchChargingStationsStatusesErrorNotification,
  OICPPatchChargingStationsErrorNotification,
  OICPPatchChargingStationsStatusesErrorNotification,
  OfflineChargingStationNotification,
  OptimalChargeReachedNotification,
  PreparingSessionNotStartedNotification,
  RequestPasswordNotification,
  ReservationNotification,
  SessionNotStartedNotification,
  TransactionStartedNotification,
  UnknownUserBadgedNotification,
  UserAccountInactivityNotification,
  UserAccountStatusChangedNotification,
  UserNotificationKeys,
  VerificationEmailNotification,
} from '../types/UserNotifications';
import Configuration from '../utils/Configuration';
import Constants from '../utils/Constants';
import Logging from '../utils/Logging';
import LoggingHelper from '../utils/LoggingHelper';
import Utils from '../utils/Utils';
import EMailNotificationTask from './email/EMailNotificationTask';
import RemotePushNotificationTask from './remote-push-notification/RemotePushNotificationTask';

const MODULE_NAME = 'NotificationHandler';

export default class NotificationHandler {
  private static notificationConfig = Configuration.getNotificationConfig();
  private static notificationSources: NotificationSource[] = [
    {
      channel: 'email',
      notificationTask: new EMailNotificationTask(),
      enabled: NotificationHandler.notificationConfig.Email
        ? NotificationHandler.notificationConfig.Email.enabled
        : false,
    },
    {
      channel: 'remote-push-notification',
      notificationTask: new RemotePushNotificationTask(),
      enabled: NotificationHandler.notificationConfig.RemotePushNotification
        ? NotificationHandler.notificationConfig.RemotePushNotification.enabled
        : false,
    },
  ];

  public static async getAdminUsers(
    tenant: Tenant,
    notificationKey?: UserNotificationKeys
  ): Promise<User[]> {
    // Get admin users
    let params;
    if (tenant.id === Constants.DEFAULT_TENANT_ID) {
      params = {
        roles: [UserRole.SUPER_ADMIN],
        notificationsActive: true,
        notifications: {} as UserNotifications,
      };
    } else {
      params = {
        roles: [UserRole.ADMIN],
        notificationsActive: true,
        notifications: {} as UserNotifications,
      };
    }
    if (notificationKey) {
      params.notifications[notificationKey] = true;
    }
    const adminUsers = await UserStorage.getUsers(tenant, params, Constants.DB_PARAMS_MAX_LIMIT);
    // Found
    if (adminUsers.count > 0) {
      return adminUsers.result;
    }
  }

  public static async hasNotifiedSource(
    tenant: Tenant,
    channel: string,
    sourceDescr: string,
    chargeBoxID: string,
    userID: string,
    interval: { intervalMins: number; additionalFilters?: any }
  ): Promise<boolean> {
    try {
      if (interval && interval.intervalMins) {
        const notifications = await NotificationStorage.getNotifications(
          tenant,
          {
            channel,
            sourceDescr,
            chargeBoxID,
            userID,
            dateFrom: interval.intervalMins
              ? moment().subtract(interval.intervalMins, 'minute').toDate()
              : null,
            additionalFilters: interval.additionalFilters ? interval.additionalFilters : null,
          },
          Constants.DB_PARAMS_COUNT_ONLY
        );
        return notifications.count > 0;
      }
      return false;
    } catch (error) {
      await Logging.logActionExceptionMessage(tenant.id, ServerAction.NOTIFICATION, error);
    }
  }

  public static async hasNotifiedSourceByID(
    tenant: Tenant,
    channel: string,
    notificationID: string
  ): Promise<boolean> {
    try {
      // Get the Notification
      const notifications = await NotificationStorage.getNotifications(
        tenant,
        {
          channel: channel,
          sourceId: notificationID,
        },
        Constants.DB_PARAMS_COUNT_ONLY
      );
      return notifications.count > 0;
    } catch (error) {
      await Logging.logActionExceptionMessage(tenant.id, ServerAction.NOTIFICATION, error);
    }
  }

  public static async sendEndOfCharge(
    tenant: Tenant,
    notificationID: string,
    user: User,
    chargingStation: ChargingStation,
    sourceData: EndOfChargeNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (user.notificationsActive && user.notifications.sendEndOfCharge) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.END_OF_CHARGE,
                  {
                    user,
                    chargingStation,
                    notificationData: {
                      transactionId: sourceData.transactionId,
                      connectorId: sourceData.connectorId,
                    },
                  }
                );
                // Send
                await notificationSource.notificationTask.sendEndOfCharge(
                  sourceData,
                  user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendEndOfCharge',
                action: ServerAction.END_OF_CHARGE,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(tenant.id, ServerAction.END_OF_CHARGE, error);
          }
        }
      }
    }
  }

  public static async sendOptimalChargeReached(
    tenant: Tenant,
    notificationID: string,
    user: User,
    chargingStation: ChargingStation,
    sourceData: OptimalChargeReachedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (user.notificationsActive && user.notifications.sendOptimalChargeReached) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.OPTIMAL_CHARGE_REACHED,
                  {
                    user,
                    chargingStation,
                    notificationData: {
                      transactionId: sourceData.transactionId,
                      connectorId: sourceData.connectorId,
                    },
                  }
                );
                // Send
                await notificationSource.notificationTask.sendOptimalChargeReached(
                  sourceData,
                  user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendOptimalChargeReached',
                action: ServerAction.OPTIMAL_CHARGE_REACHED,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.OPTIMAL_CHARGE_REACHED,
              error
            );
          }
        }
      }
    }
  }

  public static async sendEndOfTransaction(
    tenant: Tenant,
    notificationID: string,
    user: User,
    chargingStation: ChargingStation,
    sourceData: EndOfSessionNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (user.notificationsActive && user.notifications.sendEndOfSession) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.END_OF_SESSION,
                  {
                    user,
                    chargingStation,
                    notificationData: {
                      transactionId: sourceData.transactionId,
                      connectorId: sourceData.connectorId,
                    },
                  }
                );
                // Send
                await notificationSource.notificationTask.sendEndOfSession(
                  sourceData,
                  user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendEndOfSession',
                action: ServerAction.END_OF_SESSION,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(tenant.id, ServerAction.END_OF_SESSION, error);
          }
        }
      }
    }
  }

  public static async sendEndOfSignedTransaction(
    tenant: Tenant,
    notificationID: string,
    user: User,
    chargingStation: ChargingStation,
    sourceData: EndOfSignedSessionNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (user.notificationsActive && user.notifications.sendEndOfSession) {
                // Save notification
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.END_OF_SESSION,
                  {
                    user,
                    chargingStation,
                    notificationData: {
                      transactionId: sourceData.transactionId,
                      connectorId: sourceData.connectorId,
                    },
                  }
                );
                // Send
                await notificationSource.notificationTask.sendEndOfSignedSession(
                  sourceData,
                  user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendEndOfSignedSession',
                action: ServerAction.END_OF_SESSION,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(tenant.id, ServerAction.END_OF_SESSION, error);
          }
        }
      }
    }
  }

  public static async sendRequestPassword(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: RequestPasswordNotification
  ): Promise<void> {
    // For each Sources
    for (const notificationSource of NotificationHandler.notificationSources) {
      // Active?
      if (notificationSource.enabled) {
        try {
          // Save notification
          await NotificationHandler.saveNotification(
            tenant,
            notificationSource.channel,
            notificationID,
            ServerAction.REQUEST_PASSWORD,
            { user }
          );
          // Send
          await notificationSource.notificationTask.sendRequestPassword(
            sourceData,
            user,
            tenant,
            NotificationSeverity.INFO
          );
        } catch (error) {
          await Logging.logActionExceptionMessage(tenant.id, ServerAction.REQUEST_PASSWORD, error);
        }
      }
    }
  }

  public static async sendUserAccountStatusChanged(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: UserAccountStatusChangedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Enabled?
            if (user.notificationsActive && user.notifications.sendUserAccountStatusChanged) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.USER_ACCOUNT_STATUS_CHANGED,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendUserAccountStatusChanged(
                sourceData,
                user,
                tenant,
                NotificationSeverity.WARNING
              );
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.USER_ACCOUNT_STATUS_CHANGED,
              error
            );
          }
        }
      }
    }
  }

  public static async sendNewRegisteredUser(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: NewRegisteredUserNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Save
            await NotificationHandler.saveNotification(
              tenant,
              notificationSource.channel,
              notificationID,
              ServerAction.NEW_REGISTERED_USER,
              { user }
            );
            // Send
            await notificationSource.notificationTask.sendNewRegisteredUser(
              sourceData,
              user,
              tenant,
              NotificationSeverity.INFO
            );
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.NEW_REGISTERED_USER,
              error
            );
          }
        }
      }
    }
  }

  public static async sendAccountVerification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: AccountVerificationNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Save
            await NotificationHandler.saveNotification(
              tenant,
              notificationSource.channel,
              notificationID,
              ServerAction.USER_ACCOUNT_VERIFICATION,
              { user }
            );
            // Send
            await notificationSource.notificationTask.sendAccountVerificationNotification(
              sourceData,
              user,
              tenant,
              NotificationSeverity.INFO
            );
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.USER_ACCOUNT_VERIFICATION,
              error
            );
          }
        }
      }
      await this.sendAdminAccountVerification(tenant, Utils.generateUUID(), user, {
        user: user,
        evseDashboardURL: Utils.buildEvseURL(tenant.subdomain),
        evseUserToVerifyURL: Utils.buildEvseUserToVerifyURL(tenant.subdomain, user.id),
        tenantLogoURL: sourceData.tenantLogoURL,
      });
    }
  }

  public static async sendAdminAccountVerification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: AdminAccountVerificationNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Get the admin
      const adminUsers = await NotificationHandler.getAdminUsers(
        tenant,
        'sendAdminAccountVerificationNotification'
      );
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.ADMIN_ACCOUNT_VERIFICATION
              );
              // Send
              for (const adminUser of adminUsers) {
                await notificationSource.notificationTask.sendAdminAccountVerificationNotification(
                  sourceData,
                  adminUser,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.ADMIN_ACCOUNT_VERIFICATION,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendVerificationEmail(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: VerificationEmailNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
              tenant,
              notificationSource.channel,
              ServerAction.VERIFY_EMAIL,
              null,
              user.id,
              { intervalMins: 10 }
            );
            // Notified?
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.VERIFY_EMAIL,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendVerificationEmail(
                sourceData,
                user,
                tenant,
                NotificationSeverity.INFO
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendVerificationEmail',
                action: ServerAction.VERIFY_EMAIL,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(tenant.id, ServerAction.VERIFY_EMAIL, error);
          }
        }
      }
    }
  }

  public static async sendVerificationEmailUserImport(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: VerificationEmailNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Get the Tenant
      sourceData.tenantLogoURL = tenant.logo;
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Save
            await NotificationHandler.saveNotification(
              tenant,
              notificationSource.channel,
              notificationID,
              ServerAction.VERIFICATION_EMAIL_USER_IMPORT,
              { user }
            );
            // Send
            await notificationSource.notificationTask.sendVerificationEmailUserImport(
              sourceData,
              user,
              tenant,
              NotificationSeverity.INFO
            );
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.VERIFICATION_EMAIL_USER_IMPORT,
              error
            );
          }
        }
      }
    }
  }

  public static async sendChargingStationStatusError(
    tenant: Tenant,
    notificationID: string,
    chargingStation: ChargingStation,
    sourceData: ChargingStationStatusErrorNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(
        tenant,
        'sendChargingStationStatusError'
      );
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
                tenant,
                notificationSource.channel,
                ServerAction.CHARGING_STATION_STATUS_ERROR,
                sourceData.chargeBoxID,
                null,
                { intervalMins: 10 }
              );
              // Notified?
              if (!hasBeenNotified) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.CHARGING_STATION_STATUS_ERROR,
                  {
                    chargingStation,
                    notificationData: {
                      connectorId: sourceData.connectorId,
                      error: sourceData.error,
                    },
                  }
                );
                // Send
                for (const adminUser of adminUsers) {
                  await notificationSource.notificationTask.sendChargingStationStatusError(
                    sourceData,
                    adminUser,
                    tenant,
                    NotificationSeverity.ERROR
                  );
                }
              } else {
                await Logging.logDebug({
                  ...LoggingHelper.getChargingStationProperties(chargingStation),
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendChargingStationStatusError',
                  action: ServerAction.CHARGING_STATION_STATUS_ERROR,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.CHARGING_STATION_STATUS_ERROR,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendChargingStationRegistered(
    tenant: Tenant,
    notificationID: string,
    chargingStation: ChargingStation,
    sourceData: ChargingStationRegisteredNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(
        tenant,
        'sendChargingStationRegistered'
      );
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.CHARGING_STATION_REGISTERED,
                { chargingStation }
              );
              // Send
              for (const adminUser of adminUsers) {
                await notificationSource.notificationTask.sendChargingStationRegistered(
                  sourceData,
                  adminUser,
                  tenant,
                  NotificationSeverity.WARNING
                );
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.CHARGING_STATION_REGISTERED,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendUnknownUserBadged(
    tenant: Tenant,
    notificationID: string,
    chargingStation: ChargingStation,
    sourceData: UnknownUserBadgedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant, 'sendUnknownUserBadged');
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.UNKNOWN_USER_BADGED,
                { chargingStation }
              );
              // Send
              for (const adminUser of adminUsers) {
                await notificationSource.notificationTask.sendUnknownUserBadged(
                  sourceData,
                  adminUser,
                  tenant,
                  NotificationSeverity.WARNING
                );
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.UNKNOWN_USER_BADGED,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendTransactionStarted(
    tenant: Tenant,
    notificationID: string,
    user: User,
    chargingStation: ChargingStation,
    sourceData: TransactionStartedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (user.notificationsActive && user.notifications.sendSessionStarted) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.TRANSACTION_STARTED,
                  {
                    user,
                    chargingStation,
                    notificationData: {
                      transactionId: sourceData.transactionId,
                      connectorId: sourceData.connectorId,
                    },
                  }
                );
                // Send
                await notificationSource.notificationTask.sendSessionStarted(
                  sourceData,
                  user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendSessionStarted',
                action: ServerAction.TRANSACTION_STARTED,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.TRANSACTION_STARTED,
              error
            );
          }
        }
      }
    }
  }

  public static async sendOCPIPatchChargingStationsStatusesError(
    tenant: Tenant,
    sourceData: OCPIPatchChargingStationsStatusesErrorNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(
        tenant,
        'sendOcpiPatchStatusError'
      );
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
                tenant,
                notificationSource.channel,
                ServerAction.PATCH_EVSE_STATUS_ERROR,
                null,
                null,
                { intervalMins: 60 }
              );
              // Notified?
              if (!hasBeenNotified) {
                // Enabled?
                if (notificationSource.enabled) {
                  // Save
                  await NotificationHandler.saveNotification(
                    tenant,
                    notificationSource.channel,
                    null,
                    ServerAction.PATCH_EVSE_STATUS_ERROR,
                    {
                      notificationData: {
                        location: sourceData.location,
                      },
                    }
                  );
                  // Send
                  for (const adminUser of adminUsers) {
                    await notificationSource.notificationTask.sendOCPIPatchChargingStationsStatusesError(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendOCPIPatchChargingStationsStatusesError',
                  action: ServerAction.PATCH_EVSE_STATUS_ERROR,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.PATCH_EVSE_STATUS_ERROR,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendOICPPatchChargingStationsStatusesError(
    tenant: Tenant,
    sourceData: OICPPatchChargingStationsStatusesErrorNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Get admin users
      const adminUsers = await NotificationHandler.getAdminUsers(
        tenant,
        'sendOicpPatchStatusError'
      );
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
                tenant,
                notificationSource.channel,
                ServerAction.PATCH_EVSE_STATUS_ERROR,
                null,
                null,
                { intervalMins: 60 }
              );
              // Notified?
              if (!hasBeenNotified) {
                // Enabled?
                if (notificationSource.enabled) {
                  // Save
                  await NotificationHandler.saveNotification(
                    tenant,
                    notificationSource.channel,
                    null,
                    ServerAction.PATCH_EVSE_STATUS_ERROR
                  );
                  // Send
                  for (const adminUser of adminUsers) {
                    await notificationSource.notificationTask.sendOICPPatchChargingStationsStatusesError(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendOICPPatchChargingStationsStatusesError',
                  action: ServerAction.PATCH_EVSE_STATUS_ERROR,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.PATCH_EVSE_STATUS_ERROR,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendOICPPatchChargingStationsError(
    tenant: Tenant,
    sourceData: OICPPatchChargingStationsErrorNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Get admin users
      const adminUsers = await NotificationHandler.getAdminUsers(
        tenant,
        'sendOicpPatchStatusError'
      );
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
                tenant,
                notificationSource.channel,
                ServerAction.PATCH_EVSE_ERROR,
                null,
                null,
                { intervalMins: 60 }
              );
              // Notified?
              if (!hasBeenNotified) {
                // Enabled?
                if (notificationSource.enabled) {
                  // Save
                  await NotificationHandler.saveNotification(
                    tenant,
                    notificationSource.channel,
                    null,
                    ServerAction.PATCH_EVSE_ERROR
                  );
                  // Send
                  for (const adminUser of adminUsers) {
                    await notificationSource.notificationTask.sendOICPPatchChargingStationsError(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendOICPPatchChargingStationsError',
                  action: ServerAction.PATCH_EVSE_ERROR,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.PATCH_EVSE_ERROR,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendUserAccountInactivity(
    tenant: Tenant,
    user: User,
    sourceData: UserAccountInactivityNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
              tenant,
              notificationSource.channel,
              ServerAction.USER_ACCOUNT_INACTIVITY,
              null,
              user.id,
              { intervalMins: 60 * 24 * 30 }
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                null,
                ServerAction.USER_ACCOUNT_INACTIVITY,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendUserAccountInactivity(
                sourceData,
                user,
                tenant,
                NotificationSeverity.INFO
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendUserAccountInactivity',
                action: ServerAction.USER_ACCOUNT_INACTIVITY,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.USER_ACCOUNT_INACTIVITY,
              error
            );
          }
        }
      }
    }
  }

  public static async sendPreparingTransactionNotStarted(
    tenant: Tenant,
    chargingStation: ChargingStation,
    user: User,
    sourceData: PreparingSessionNotStartedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
              tenant,
              notificationSource.channel,
              ServerAction.PREPARING_SESSION_NOT_STARTED,
              chargingStation.id,
              user.id,
              { intervalMins: 15 }
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (user.notificationsActive && user.notifications.sendPreparingSessionNotStarted) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  null,
                  ServerAction.PREPARING_SESSION_NOT_STARTED,
                  {
                    user,
                    chargingStation,
                    notificationData: {
                      connectorId: sourceData.connectorId,
                    },
                  }
                );
                // Send
                await notificationSource.notificationTask.sendPreparingSessionNotStarted(
                  sourceData,
                  user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendPreparingSessionNotStarted',
                action: ServerAction.PREPARING_SESSION_NOT_STARTED,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.PREPARING_SESSION_NOT_STARTED,
              error
            );
          }
        }
      }
    }
  }

  public static async sendOfflineChargingStations(
    tenant: Tenant,
    sourceData: OfflineChargingStationNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant);
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
                tenant,
                notificationSource.channel,
                ServerAction.OFFLINE_CHARGING_STATIONS,
                null,
                null,
                { intervalMins: 60 * 24 }
              );
              // Notified?
              if (!hasBeenNotified) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  null,
                  ServerAction.OFFLINE_CHARGING_STATIONS
                );
                // Send
                for (const adminUser of adminUsers) {
                  // Enabled?
                  if (
                    adminUser.notificationsActive &&
                    adminUser.notifications.sendOfflineChargingStations
                  ) {
                    await notificationSource.notificationTask.sendOfflineChargingStations(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.INFO
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendOfflineChargingStations',
                  action: ServerAction.OFFLINE_CHARGING_STATIONS,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.OFFLINE_CHARGING_STATIONS,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendBillingSynchronizationFailed(
    tenant: Tenant,
    sourceData: BillingUserSynchronizationFailedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant);
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
                tenant,
                notificationSource.channel,
                ServerAction.BILLING_USER_SYNCHRONIZATION_FAILED
              );
              // Notified?
              if (!hasBeenNotified) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  null,
                  ServerAction.BILLING_USER_SYNCHRONIZATION_FAILED
                );
                // Send
                for (const adminUser of adminUsers) {
                  // Enabled?
                  if (
                    adminUser.notificationsActive &&
                    adminUser.notifications.sendBillingSynchronizationFailed
                  ) {
                    await notificationSource.notificationTask.sendBillingSynchronizationFailed(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendBillingSynchronizationFailed',
                  action: ServerAction.BILLING_USER_SYNCHRONIZATION_FAILED,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.BILLING_USER_SYNCHRONIZATION_FAILED,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendBillingInvoicesSynchronizationFailed(
    tenant: Tenant,
    sourceData: BillingInvoiceSynchronizationFailedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant);
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
                tenant,
                notificationSource.channel,
                ServerAction.BILLING_INVOICE_SYNCHRONIZATION_FAILED
              );
              // Notified?
              if (!hasBeenNotified) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  null,
                  ServerAction.BILLING_INVOICE_SYNCHRONIZATION_FAILED
                );
                // Send
                for (const adminUser of adminUsers) {
                  // Enabled?
                  if (
                    adminUser.notificationsActive &&
                    adminUser.notifications.sendBillingSynchronizationFailed
                  ) {
                    await notificationSource.notificationTask.sendBillingInvoiceSynchronizationFailed(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendBillingInvoicesSynchronizationFailed',
                  action: ServerAction.BILLING_INVOICE_SYNCHRONIZATION_FAILED,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.BILLING_USER_SYNCHRONIZATION_FAILED,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendBillingPeriodicOperationFailed(
    tenant: Tenant,
    sourceData: BillingInvoiceSynchronizationFailedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant);
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
                tenant,
                notificationSource.channel,
                ServerAction.BILLING_PERFORM_OPERATIONS
              );
              // Notified?
              if (!hasBeenNotified) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  null,
                  ServerAction.BILLING_PERFORM_OPERATIONS
                );
                // Send
                for (const adminUser of adminUsers) {
                  // Enabled?
                  if (
                    adminUser.notificationsActive &&
                    adminUser.notifications.sendBillingPeriodicOperationFailed
                  ) {
                    await notificationSource.notificationTask.sendBillingPeriodicOperationFailed(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendBillingPeriodicOperationFailed',
                  action: ServerAction.BILLING_PERFORM_OPERATIONS,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.BILLING_PERFORM_OPERATIONS,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendCarsSynchronizationFailed(
    sourceData: CarCatalogSynchronizationFailedNotification
  ): Promise<void> {
    // Get admin users
    const adminUsers = await NotificationHandler.getAdminUsers(Constants.DEFAULT_TENANT_OBJECT);
    if (!Utils.isEmptyArray(adminUsers)) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
              Constants.DEFAULT_TENANT_OBJECT,
              notificationSource.channel,
              ServerAction.CAR_CATALOG_SYNCHRONIZATION_FAILED,
              null,
              null,
              { intervalMins: 60 * 24 }
            );
            // Notified?
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                Constants.DEFAULT_TENANT_OBJECT,
                notificationSource.channel,
                null,
                ServerAction.CAR_CATALOG_SYNCHRONIZATION_FAILED
              );
              // Send
              for (const adminUser of adminUsers) {
                // Enabled?
                if (
                  adminUser.notificationsActive &&
                  adminUser.notifications.sendCarCatalogSynchronizationFailed
                ) {
                  await notificationSource.notificationTask.sendCarCatalogSynchronizationFailed(
                    sourceData,
                    adminUser,
                    Constants.DEFAULT_TENANT_OBJECT,
                    NotificationSeverity.ERROR
                  );
                }
              }
            } else {
              await Logging.logDebug({
                tenantID: Constants.DEFAULT_TENANT_OBJECT.id,
                module: MODULE_NAME,
                method: 'sendCarsSynchronizationFailed',
                action: ServerAction.CAR_CATALOG_SYNCHRONIZATION_FAILED,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              Constants.DEFAULT_TENANT_ID,
              ServerAction.CAR_CATALOG_SYNCHRONIZATION_FAILED,
              error
            );
          }
        }
      }
    }
  }

  public static async sendComputeAndApplyChargingProfilesFailed(
    tenant: Tenant,
    chargingStation: ChargingStation,
    sourceData: ComputeAndApplyChargingProfilesFailedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant);
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Check notification
              const hasBeenNotified = await NotificationHandler.hasNotifiedSource(
                tenant,
                notificationSource.channel,
                ServerAction.COMPUTE_AND_APPLY_CHARGING_PROFILES_FAILED,
                sourceData.chargeBoxID,
                null,
                { intervalMins: 60 * 24 }
              );
              // Notified?
              if (!hasBeenNotified) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  null,
                  ServerAction.COMPUTE_AND_APPLY_CHARGING_PROFILES_FAILED,
                  { chargingStation: chargingStation }
                );
                // Send
                for (const adminUser of adminUsers) {
                  // Enabled?
                  if (
                    adminUser.notificationsActive &&
                    adminUser.notifications.sendComputeAndApplyChargingProfilesFailed
                  ) {
                    await notificationSource.notificationTask.sendComputeAndApplyChargingProfilesFailed(
                      sourceData,
                      adminUser,
                      tenant,
                      NotificationSeverity.ERROR
                    );
                  }
                }
              } else {
                await Logging.logDebug({
                  ...LoggingHelper.getChargingStationProperties(chargingStation),
                  tenantID: tenant.id,
                  module: MODULE_NAME,
                  method: 'sendComputeAndApplyChargingProfilesFailed',
                  action: ServerAction.COMPUTE_AND_APPLY_CHARGING_PROFILES_FAILED,
                  message: `Notification via '${notificationSource.channel}' has already been sent`,
                });
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.COMPUTE_AND_APPLY_CHARGING_PROFILES_FAILED,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendEndUserErrorNotification(
    tenant: Tenant,
    sourceData: EndUserErrorNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // Enrich with admins
      const adminUsers = await NotificationHandler.getAdminUsers(tenant);
      if (!Utils.isEmptyArray(adminUsers)) {
        // For each Sources
        for (const notificationSource of NotificationHandler.notificationSources) {
          // Active?
          if (notificationSource.enabled) {
            try {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                null,
                ServerAction.END_USER_REPORT_ERROR,
                {
                  notificationData: {
                    userID: sourceData.userID,
                  },
                }
              );
              // Send
              for (const adminUser of adminUsers) {
                // Enabled?
                if (
                  adminUser.notificationsActive &&
                  adminUser.notifications.sendEndUserErrorNotification
                ) {
                  await notificationSource.notificationTask.sendEndUserErrorNotification(
                    sourceData,
                    adminUser,
                    tenant,
                    NotificationSeverity.ERROR
                  );
                }
              }
            } catch (error) {
              await Logging.logActionExceptionMessage(
                tenant.id,
                ServerAction.END_USER_REPORT_ERROR,
                error
              );
            }
          }
        }
      }
    }
  }

  public static async sendTransactionNotStarted(
    tenant: Tenant,
    notificationID: string,
    chargingStation: ChargingStation,
    sourceData: SessionNotStartedNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (
                sourceData.user.notificationsActive &&
                sourceData.user.notifications.sendSessionNotStarted
              ) {
                // Save
                await NotificationHandler.saveNotification(
                  tenant,
                  notificationSource.channel,
                  notificationID,
                  ServerAction.SESSION_NOT_STARTED_AFTER_AUTHORIZE,
                  {
                    user: sourceData.user,
                    chargingStation,
                  }
                );
                // Send
                await notificationSource.notificationTask.sendSessionNotStarted(
                  sourceData,
                  sourceData.user,
                  tenant,
                  NotificationSeverity.INFO
                );
              }
            } else {
              await Logging.logDebug({
                ...LoggingHelper.getChargingStationProperties(chargingStation),
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendSessionNotStarted',
                action: ServerAction.SESSION_NOT_STARTED_AFTER_AUTHORIZE,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.SESSION_NOT_STARTED_AFTER_AUTHORIZE,
              error
            );
          }
        }
      }
    }
  }

  public static async sendBillingNewInvoiceNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: BillingNewInvoiceNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Enabled?
              if (
                sourceData.user.notificationsActive &&
                sourceData.user.notifications.sendBillingNewInvoice
              ) {
                if (sourceData.invoiceStatus) {
                  await NotificationHandler.saveNotification(
                    tenant,
                    notificationSource.channel,
                    notificationID,
                    ServerAction.BILLING_NEW_INVOICE,
                    { user }
                  );
                  // Send
                  await notificationSource.notificationTask.sendBillingNewInvoice(
                    sourceData,
                    user,
                    tenant,
                    NotificationSeverity.INFO
                  );
                }
              }
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendBillingNewInvoiceNotification',
                action: ServerAction.BILLING_NEW_INVOICE,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.BILLING_NEW_INVOICE,
              error
            );
          }
        }
      }
    }
  }

  public static async sendBillingAccountCreationLink(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: BillingAccountCreationLinkNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Save
            await NotificationHandler.saveNotification(
              tenant,
              notificationSource.channel,
              notificationID,
              ServerAction.BILLING_ACCOUNT_CREATE,
              { user }
            );
            // Send
            await notificationSource.notificationTask.sendBillingAccountCreationLink(
              sourceData,
              user,
              tenant,
              NotificationSeverity.INFO
            );
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.BILLING_ACCOUNT_CREATE,
              error
            );
          }
        }
      }
    }
  }

  public static async sendBillingAccountActivationNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: BillingAccountActivationNotification
  ): Promise<void> {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      // For each Sources
      for (const notificationSource of NotificationHandler.notificationSources) {
        // Active?
        if (notificationSource.enabled) {
          try {
            // Save
            await NotificationHandler.saveNotification(
              tenant,
              notificationSource.channel,
              notificationID,
              ServerAction.BILLING_ACCOUNT_ACTIVATE,
              { user }
            );
            // Send
            await notificationSource.notificationTask.sendBillingAccountActivationNotification(
              sourceData,
              user,
              tenant,
              NotificationSeverity.INFO
            );
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.BILLING_ACCOUNT_ACTIVATE,
              error
            );
          }
        }
      }
    }
  }

  public static async sendReservationStatusNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: ReservationNotification
  ) {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.RESERVATION_STATUS_TRANSITION,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendReservationStatusNotification(
                sourceData,
                user,
                tenant,
                NotificationSeverity.INFO
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendReservationStatusNotification',
                action: ServerAction.RESERVATION_STATUS_TRANSITION,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.RESERVATION_STATUS_TRANSITION,
              error
            );
          }
        }
      }
    }
  }

  public static async sendUpcomingReservationNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: ReservationNotification
  ) {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.RESERVATION_UPCOMING,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendUpcomingReservationNotification(
                sourceData,
                user,
                tenant,
                NotificationSeverity.INFO
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendUpcomingReservationNotification',
                action: ServerAction.RESERVATION_STATUS_TRANSITION,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.RESERVATION_UPCOMING,
              error
            );
          }
        }
      }
    }
  }

  public static async sendReservedChargingStationBlocked(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: ReservationNotification
  ) {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.RESERVATION_CHARGING_STATION_BLOCKED,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendReservedChargingStationBlockedNotification(
                sourceData,
                user,
                tenant,
                NotificationSeverity.WARNING
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendReservedChargingStationBlocked',
                action: ServerAction.RESERVATION_CHARGING_STATION_BLOCKED,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.RESERVATION_CHARGING_STATION_BLOCKED,
              error
            );
          }
        }
      }
    }
  }

  public static async sendReservationCreatedNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: ReservationNotification
  ) {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.RESERVATION_CREATE,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendReservationCreatedNotification(
                sourceData,
                user,
                tenant,
                NotificationSeverity.INFO
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendReservationCreatedNotification',
                action: ServerAction.RESERVATION_CREATE,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.RESERVATION_CREATE,
              error
            );
          }
        }
      }
    }
  }

  public static async sendReservationCancelledNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: ReservationNotification
  ) {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.RESERVATION_CANCEL,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendReservationCancelledNotification(
                sourceData,
                user,
                tenant,
                NotificationSeverity.INFO
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendReservationCancelledNotification',
                action: ServerAction.RESERVATION_CANCEL,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.RESERVATION_CANCEL,
              error
            );
          }
        }
      }
    }
  }

  public static async sendReservationUnmetNotification(
    tenant: Tenant,
    notificationID: string,
    user: User,
    sourceData: ReservationNotification
  ) {
    if (tenant.id !== Constants.DEFAULT_TENANT_ID) {
      for (const notificationSource of NotificationHandler.notificationSources) {
        if (notificationSource.enabled) {
          try {
            // Check notification
            const hasBeenNotified = await NotificationHandler.hasNotifiedSourceByID(
              tenant,
              notificationSource.channel,
              notificationID
            );
            if (!hasBeenNotified) {
              // Save
              await NotificationHandler.saveNotification(
                tenant,
                notificationSource.channel,
                notificationID,
                ServerAction.RESERVATION_UNMET,
                { user }
              );
              // Send
              await notificationSource.notificationTask.sendReservationUnmetNotification(
                sourceData,
                user,
                tenant,
                NotificationSeverity.WARNING
              );
            } else {
              await Logging.logDebug({
                tenantID: tenant.id,
                module: MODULE_NAME,
                method: 'sendReservationUnmetNotification',
                action: ServerAction.RESERVATION_UNMET,
                user: user.id,
                message: `Notification via '${notificationSource.channel}' has already been sent`,
              });
            }
          } catch (error) {
            await Logging.logActionExceptionMessage(
              tenant.id,
              ServerAction.RESERVATION_UNMET,
              error
            );
          }
        }
      }
    }
  }

  private static async saveNotification(
    tenant: Tenant,
    channel: string,
    notificationID: string,
    sourceDescr: ServerAction,
    extraParams: { user?: User; chargingStation?: ChargingStation; notificationData?: any } = {}
  ): Promise<void> {
    // Save it
    await NotificationStorage.saveNotification(tenant, {
      timestamp: new Date(),
      channel: channel,
      sourceId: notificationID ? notificationID : new Date().toISOString(),
      sourceDescr: sourceDescr,
      userID: extraParams.user ? extraParams.user.id : null,
      chargeBoxID: extraParams.chargingStation ? extraParams.chargingStation.id : null,
      data: extraParams.notificationData,
    });
    // Success
    if (extraParams.user) {
      // User
      await Logging.logDebug({
        tenantID: tenant.id,
        siteID: extraParams.chargingStation?.siteID,
        siteAreaID: extraParams.chargingStation?.siteAreaID,
        companyID: extraParams.chargingStation?.companyID,
        chargingStationID: extraParams.chargingStation?.id,
        module: MODULE_NAME,
        method: 'saveNotification',
        action: sourceDescr,
        actionOnUser: extraParams.user,
        message: `User is being notified (${channel})`,
      });
    } else {
      // Admin
      await Logging.logDebug({
        tenantID: tenant.id,
        siteID: extraParams.chargingStation?.siteID,
        siteAreaID: extraParams.chargingStation?.siteAreaID,
        companyID: extraParams.chargingStation?.companyID,
        chargingStationID: extraParams.chargingStation?.id,
        module: MODULE_NAME,
        method: 'saveNotification',
        action: sourceDescr,
        message: `Admin users are being notified (${channel})`,
      });
    }
  }
}
